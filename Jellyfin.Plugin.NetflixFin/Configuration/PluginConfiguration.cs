using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.NetflixFin.Configuration;

/// <summary>
/// NetflixFin user-facing options. Everything here is surfaced to the browser as CSS
/// custom properties or as a JSON settings blob consumed by netflixfin.js.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets the primary accent colour. Netflix red by default.
    /// </summary>
    public string AccentColor { get; set; } = "#E50914";

    /// <summary>
    /// Gets or sets the page background colour.
    /// </summary>
    public string BackgroundColor { get; set; } = "#141414";

    /// <summary>
    /// Gets or sets the corner radius applied to cards, in pixels.
    /// </summary>
    public int CardRadius { get; set; } = 6;

    /// <summary>
    /// Gets or sets a value indicating whether cards scale up and reveal a
    /// detail panel on hover, the way a Netflix row behaves.
    /// </summary>
    public bool EnableHoverPreview { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether titles/subtitles under cards are hidden.
    /// </summary>
    public bool HideCardText { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether portrait posters are swapped for
    /// 16:9 backdrops in home rows. Requires the script layer.
    /// </summary>
    public bool UseWideThumbnails { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether the first home row is promoted to a
    /// full-bleed hero banner.
    /// </summary>
    public bool EnableHeroBanner { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether the hero banner cycles through items.
    /// </summary>
    public bool HeroAutoRotate { get; set; } = true;

    /// <summary>
    /// Gets or sets how long, in seconds, each hero item stays on screen.
    /// </summary>
    public int HeroRotateSeconds { get; set; } = 12;

    /// <summary>
    /// Gets or sets a value indicating whether the hero swaps its artwork for the title's
    /// trailer after a moment, the way Netflix's billboard does.
    /// </summary>
    public bool EnableHeroTrailer { get; set; } = true;

    /// <summary>
    /// Gets or sets how long the artwork is held before the trailer takes over.
    /// </summary>
    public int HeroTrailerDelaySeconds { get; set; } = 3;

    /// <summary>
    /// Gets or sets a value indicating whether rows named like "Top 10" get
    /// oversized rank numerals.
    /// </summary>
    public bool EnableTop10 { get; set; } = true;

    /// <summary>
    /// Gets or sets an optional replacement for the header logo. Any URL or data URI.
    /// </summary>
    public string LogoUrl { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets a value indicating whether the stylesheet is served at all.
    /// </summary>
    public bool EnableCss { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether the behaviour script is served at all.
    /// </summary>
    public bool EnableScript { get; set; } = true;

    /// <summary>
    /// Gets or sets extra CSS appended after the theme, for per-server tweaks.
    /// </summary>
    public string CustomCss { get; set; } = string.Empty;
}
