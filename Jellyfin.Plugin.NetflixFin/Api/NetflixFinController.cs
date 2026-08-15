using System.Globalization;
using System.Resources;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.NetflixFin.Configuration;
using Microsoft.AspNetCore.Authorization;
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

    /// <summary>
    /// Gets the stylesheet, with the configured tokens spliced in as CSS custom properties.
    /// </summary>
    [HttpGet("netflixfin.css")]
    [Produces("text/css")]
    public ActionResult GetStylesheet()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        if (!config.EnableCss)
        {
            return Content(string.Empty, "text/css", Encoding.UTF8);
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

        return Content(css.ToString(), "text/css", Encoding.UTF8);
    }

    /// <summary>
    /// Gets the behaviour script, prefixed with the serialised plugin configuration.
    /// </summary>
    [HttpGet("netflixfin.js")]
    [Produces("application/javascript")]
    public ActionResult GetScript()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        if (!config.EnableScript)
        {
            return Content(string.Empty, "application/javascript", Encoding.UTF8);
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
                config.EnableTop10,
                config.LogoUrl,
                config.AccentColor
            },
            _json);

        var js = "window.NetflixFinConfig=" + settings + ";\n" + ReadResource("Web.netflixfin.js");
        return Content(js, "application/javascript", Encoding.UTF8);
    }

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
