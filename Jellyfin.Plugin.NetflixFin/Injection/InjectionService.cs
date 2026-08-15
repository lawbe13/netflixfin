using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NetflixFin.Injection;

/// <summary>
/// Jellyfin has no supported hook for adding assets to the web client, so the theme is
/// wired in one of two ways:
///
///   1. Through the File Transformation plugin, which rewrites index.html as it is
///      served. Nothing is touched on disk, so this works on read-only web roots.
///   2. By patching index.html directly, between comment markers, re-applied on every
///      start and removed on graceful shutdown.
///
/// (1) is tried first and (2) is the fallback.
/// </summary>
public partial class InjectionService : IHostedService
{
    private const string StartMarker = HtmlBlock.Start;
    private const string EndMarker = HtmlBlock.End;

    private bool _usingFileTransformation;

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
        _usingFileTransformation = FileTransformationRegistrar.TryRegister(_logger);

        if (_usingFileTransformation)
        {
            // A previous run may have left the on-disk block behind; drop it so the two
            // strategies cannot both fire.
            Patch(inject: false);
            return Task.CompletedTask;
        }

        Patch(inject: true);
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        if (!_usingFileTransformation)
        {
            Patch(inject: false);
        }

        return Task.CompletedTask;
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

                updated = stripped.Insert(closingBody, HtmlBlock.Build());
            }

            if (!string.Equals(updated, html, StringComparison.Ordinal))
            {
                File.WriteAllText(indexPath, updated);
                _logger.LogInformation("NetflixFin: index.html {Action}", inject ? "patched" : "restored");
            }
        }
        catch (UnauthorizedAccessException)
        {
            _logger.LogError(
                "NetflixFin: cannot write {Path} and the File Transformation plugin is not available. "
                + "Install File Transformation (it needs no configuration) or grant the Jellyfin service "
                + "write access to the web root",
                indexPath);
        }
        catch (IOException ex)
        {
            _logger.LogError(ex, "NetflixFin: failed to update {Path}", indexPath);
        }
    }
}
