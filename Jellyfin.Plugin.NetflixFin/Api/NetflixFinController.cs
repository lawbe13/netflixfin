using System.Globalization;
using System.Resources;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.NetflixFin.Awards;
using Jellyfin.Plugin.NetflixFin.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.NetflixFin.Api;

/// <summary>
/// Serves the theme assets. Both endpoints are anonymous because the login page needs
/// them before a token exists.
/// </summary>
[ApiController]
[Route("NetflixFin")]
[AllowAnonymous]
public class NetflixFinController : ControllerBase
{
    private static readonly JsonSerializerOptions _json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    /* The stylesheet and the script are 178 KB between them and were rebuilt from their
       embedded resources, string by string, on every request - and answered with no
       validator at all, so every page load fetched the lot again. Both are now built
       once per configuration and served against an ETag, which turns the repeat visit
       into a 304 of a couple of hundred bytes. */
    private static readonly object _buildLock = new();
    private static string? _builtFor;
    private static string? _css;
    private static string? _js;

    private static (string Body, string Tag) Asset(bool stylesheet)
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var key = Fingerprint(config);

        lock (_buildLock)
        {
            if (_builtFor != key)
            {
                _css = null;
                _js = null;
                _builtFor = key;
            }

            var cached = stylesheet ? _css : _js;
            if (cached == null)
            {
                cached = stylesheet ? BuildStylesheet(config) : BuildScript(config);
                if (stylesheet)
                {
                    _css = cached;
                }
                else
                {
                    _js = cached;
                }
            }

            return (cached, "\"" + key + (stylesheet ? "c" : "j") + "\"");
        }
    }

    /// <summary>
    /// Identifies the exact bytes the assets would be built from: the plugin build plus
    /// every setting that is spliced into them.
    /// </summary>
    private static string Fingerprint(PluginConfiguration config)
    {
        var version = typeof(Plugin).Assembly.GetName().Version?.ToString() ?? "0";
        var bytes = Encoding.UTF8.GetBytes(version + "|" + JsonSerializer.Serialize(config, _json));
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes), 0, 8);
    }

    private ActionResult Serve(string body, string tag, string contentType)
    {
        Response.Headers.ETag = tag;
        // Revalidate rather than expire: a settings change has to reach the browser the
        // moment it is saved, and a 304 costs almost nothing on a local network.
        Response.Headers.CacheControl = "no-cache";

        if (Request.Headers.IfNoneMatch.Count > 0
            && Request.Headers.IfNoneMatch.ToString().Contains(tag, StringComparison.Ordinal))
        {
            return StatusCode(StatusCodes.Status304NotModified);
        }

        return Content(body, contentType, Encoding.UTF8);
    }

    /// <summary>
    /// Gets the stylesheet, with the configured tokens spliced in as CSS custom properties.
    /// </summary>
    [HttpGet("netflixfin.css")]
    [Produces("text/css")]
    public ActionResult GetStylesheet()
    {
        var asset = Asset(stylesheet: true);
        return Serve(asset.Body, asset.Tag, "text/css");
    }

    private static string BuildStylesheet(PluginConfiguration config)
    {
        if (!config.EnableCss)
        {
            return string.Empty;
        }

        var css = new StringBuilder();
        css.Append(":root{")
           .Append(CultureInfo.InvariantCulture, $"--nf-accent:{Sanitize(config.AccentColor, "#E50914")};")
           .Append(CultureInfo.InvariantCulture, $"--nf-bg:{Sanitize(config.BackgroundColor, "#141414")};")
           .Append(CultureInfo.InvariantCulture, $"--nf-card-radius:{Math.Clamp(config.CardRadius, 0, 32)}px;")
           .Append(CultureInfo.InvariantCulture, $"--nf-hero-rotate:{Math.Clamp(config.HeroRotateSeconds, 4, 120)}s;")
           .Append('}');

        css.Append(ReadResource("Web.netflixfin.css"));

        if (!string.IsNullOrWhiteSpace(config.CustomCss))
        {
            css.Append('\n').Append(config.CustomCss);
        }

        return css.ToString();
    }

    /// <summary>
    /// Gets the behaviour script, prefixed with the serialised plugin configuration.
    /// </summary>
    [HttpGet("netflixfin.js")]
    [Produces("application/javascript")]
    public ActionResult GetScript()
    {
        var asset = Asset(stylesheet: false);
        return Serve(asset.Body, asset.Tag, "application/javascript");
    }

    private static string BuildScript(PluginConfiguration config)
    {
        if (!config.EnableScript)
        {
            return string.Empty;
        }

        var settings = JsonSerializer.Serialize(
            new
            {
                config.EnableHoverPreview,
                config.HideCardText,
                config.UseWideThumbnails,
                config.EnableHeroBanner,
                config.HeroAutoRotate,
                config.HeroRotateSeconds,
                config.EnableHeroTrailer,
                config.HeroTrailerDelaySeconds,
                config.EnableTop10,
                config.LogoUrl,
                config.AccentColor
            },
            _json);

        return "window.NetflixFinConfig=" + settings + ";\n" + ReadResource("Web.netflixfin.js");
    }

    /// <summary>
    /// Gets the award tallies for the library, keyed by IMDb ID.
    /// </summary>
    /// <remarks>
    /// Titles with no awards are simply absent, so the map stays small — 127 entries out of
    /// 744 titles on the library this was built against. The client fetches it once.
    /// </remarks>
    [HttpGet("awards")]
    [Produces("application/json")]
    public ActionResult GetAwards()
    {
        var service = AwardsService.Instance;
        if (service == null)
        {
            return new JsonResult(new { updatedUtc = (DateTime?)null, titles = new Dictionary<string, object>() });
        }

        // Cheap to ask on every call: it returns immediately unless the cache has aged out,
        // and the refresh itself runs under a lock that drops concurrent callers.
        _ = service.RefreshIfStaleAsync(CancellationToken.None);

        return new JsonResult(new { updatedUtc = service.UpdatedUtc, titles = service.Titles }, _json);
    }

    /// <summary>
    /// Gets a channel's station ident.
    /// </summary>
    /// <remarks>
    /// The clips are played by a video element of the theme's own rather than
    /// through Jellyfin's player: they are already in a format every browser
    /// takes, so there is nothing to transcode, and they never become items in
    /// anybody's library.
    /// </remarks>
    /// <param name="channel">The channel's id, as the theme knows it.</param>
    [HttpGet("tv/ident/{channel}")]
    [Produces("video/mp4")]
    public ActionResult GetIdent(string channel)
    {
        // The name goes into a resource path, so it is matched rather than trusted.
        if (string.IsNullOrEmpty(channel) || !Channels.Contains(channel, StringComparer.Ordinal))
        {
            return NotFound();
        }

        var assembly = typeof(NetflixFinController).Assembly;
        var name = typeof(Plugin).Namespace + ".Web.tv." + channel + ".mp4";
        var stream = assembly.GetManifestResourceStream(name);
        if (stream == null)
        {
            return NotFound();
        }

        // They never change between builds, so they are worth keeping.
        Response.Headers.CacheControl = "public, max-age=604800, immutable";
        return File(stream, "video/mp4");
    }

    /// <summary>
    /// Gets a channel's lockup.
    /// </summary>
    /// <param name="channel">The channel's id, as the theme knows it.</param>
    /// <param name="mono">
    /// The on-air version: the same shape in flat white with the channel's name
    /// knocked out of the tag, which is what a broadcaster puts in the corner of
    /// the picture. Derived from the colour one by tools/mono-logos.py.
    /// </param>
    [HttpGet("tv/logo/{channel}")]
    [Produces("image/svg+xml")]
    public ActionResult GetChannelLogo(string channel, [FromQuery] bool mono = false)
    {
        // Matched rather than trusted: the name goes into a resource path.
        if (string.IsNullOrEmpty(channel) || !Channels.Contains(channel, StringComparer.Ordinal))
        {
            return NotFound();
        }

        var assembly = typeof(NetflixFinController).Assembly;
        var name = typeof(Plugin).Namespace + ".Web.tv.logos." + channel
            + (mono ? ".mono" : string.Empty) + ".svg";
        var stream = assembly.GetManifestResourceStream(name);
        if (stream == null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "public, max-age=604800, immutable";
        return File(stream, "image/svg+xml");
    }

    /// <summary>
    /// Gets a piece of the server's own branding.
    /// </summary>
    /// <param name="name">
    /// Which piece: the wordmark for the header, the mark on its own, or the
    /// icons a browser asks for. These used to belong to another plugin, which
    /// is why the theme could read the wordmark off the page and never had to
    /// own one. It owns them now.
    /// </param>
    [HttpGet("brand/{name}")]
    public ActionResult GetBrand(string name)
    {
        // Matched rather than trusted: the name goes into a resource path.
        if (string.IsNullOrEmpty(name) || !Brands.ContainsKey(name))
        {
            return NotFound();
        }

        var file = Brands[name];
        var assembly = typeof(NetflixFinController).Assembly;
        var stream = assembly.GetManifestResourceStream(
            typeof(Plugin).Namespace + ".Web.brand." + file);
        if (stream == null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "public, max-age=604800, immutable";
        return File(stream, file.EndsWith(".ico", StringComparison.Ordinal)
            ? "image/x-icon"
            : "image/png");
    }

    /// <summary>
    /// The pieces of branding the plugin carries, by the name the theme asks
    /// for, so that a request cannot reach an arbitrary embedded resource.
    /// </summary>
    private static readonly Dictionary<string, string> Brands = new(StringComparer.Ordinal)
    {
        { "banner", "banner-dark.png" },
        { "banner-light", "banner-light.png" },
        { "mark", "icon-transparent.png" },
        { "favicon", "favicon.ico" },
        { "touch-icon", "apple-touch-icon.png" }
    };

    /// <summary>
    /// The channels the theme defines, mirrored here only so that a request for
    /// an ident or a lockup cannot ask for an arbitrary embedded resource.
    /// </summary>
    private static readonly string[] Channels =
    {
        "uno", "action", "comedy", "family", "scifi", "suspense",
        "drama", "saghe", "classici", "serie", "sitcom", "nonstop"
    };

    private static string Sanitize(string? value, string fallback)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return fallback;
        }

        // Keep the value from escaping the declaration it is written into.
        return value.IndexOfAny(new[] { ';', '{', '}', '<', '>', '"', '\'', '\\', '(', ')' }) >= 0
            ? fallback
            : value.Trim();
    }

    private static string ReadResource(string relativeName)
    {
        var assembly = typeof(NetflixFinController).Assembly;
        var name = typeof(Plugin).Namespace + "." + relativeName;
        using var stream = assembly.GetManifestResourceStream(name)
            ?? throw new MissingManifestResourceException(name);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }
}
