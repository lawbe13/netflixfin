using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NetflixFin.Injection;

/// <summary>
/// Jellyfin has no supported hook for adding assets to the web client, so the theme is
/// wired in by patching index.html at server start. The patch is delimited by comment
/// markers, is re-applied after every jellyfin-web update, and is removed again on
/// graceful shutdown so an uninstall leaves nothing behind.
/// </summary>
public partial class InjectionService : IHostedService
{
    private const string StartMarker = "<!-- NetflixFin:start -->";
    private const string EndMarker = "<!-- NetflixFin:end -->";

    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<InjectionService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="InjectionService"/> class.
    /// </summary>
    public InjectionService(IApplicationPaths appPaths, ILogger<InjectionService> logger)
    {
        _appPaths = appPaths;
        _logger = logger;
    }

    [GeneratedRegex(@"<!-- NetflixFin:start -->.*?<!-- NetflixFin:end -->", RegexOptions.Singleline)]
    private static partial Regex BlockRegex();

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        Patch(inject: true);
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        Patch(inject: false);
        return Task.CompletedTask;
    }

    private static string BuildBlock()
    {
        // Cache-bust on every start so a theme update is picked up without a hard reload.
        var stamp = DateTime.UtcNow.Ticks.ToString("x", System.Globalization.CultureInfo.InvariantCulture);
        return StartMarker
            + $"<link rel=\"stylesheet\" href=\"/NetflixFin/netflixfin.css?v={stamp}\">"
            + $"<script defer src=\"/NetflixFin/netflixfin.js?v={stamp}\"></script>"
            + EndMarker;
    }

    private void Patch(bool inject)
    {
        var indexPath = Path.Combine(_appPaths.WebPath, "index.html");

        try
        {
            if (!File.Exists(indexPath))
            {
                _logger.LogWarning("NetflixFin: {Path} not found, theme not injected", indexPath);
                return;
            }

            var html = File.ReadAllText(indexPath);
            var stripped = BlockRegex().Replace(html, string.Empty);

            var updated = stripped;
            if (inject)
            {
                var closingBody = stripped.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
                if (closingBody < 0)
                {
                    _logger.LogWarning("NetflixFin: no </body> in index.html, theme not injected");
                    return;
                }

                updated = stripped.Insert(closingBody, BuildBlock());
            }

            if (!string.Equals(updated, html, StringComparison.Ordinal))
            {
                File.WriteAllText(indexPath, updated);
                _logger.LogInformation("NetflixFin: index.html {Action}", inject ? "patched" : "restored");
            }
        }
        catch (UnauthorizedAccessException ex)
        {
            _logger.LogError(
                ex,
                "NetflixFin: cannot write {Path}. The web root is read-only - see the plugin README for the "
                + "custom-CSS fallback",
                indexPath);
        }
        catch (IOException ex)
        {
            _logger.LogError(ex, "NetflixFin: failed to update {Path}", indexPath);
        }
    }
}
