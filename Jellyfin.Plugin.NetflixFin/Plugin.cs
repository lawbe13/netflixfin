using System.Globalization;
using Jellyfin.Plugin.NetflixFin.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.NetflixFin;

/// <summary>
/// NetflixFin - a Netflix-styled skin for the Jellyfin web client.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "NetflixFin";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("b8e0f7c2-6b3a-4a4a-9e2f-1d5c7a9b3e41");

    /// <inheritdoc />
    public override string Description =>
        "Turns the Jellyfin web client into a Netflix-style interface: cinematic hero banner, "
        + "16:9 rows, expanding hover previews, pill buttons and Top 10 numbering.";

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = string.Format(
                    CultureInfo.InvariantCulture,
                    "{0}.Configuration.configPage.html",
                    GetType().Namespace)
            }
        };
    }
}
