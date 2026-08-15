using System.Reflection;
using System.Runtime.Loader;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NetflixFin.Injection;

/// <summary>
/// Registers the theme with the File Transformation plugin, which rewrites jellyfin-web
/// files as they are served instead of on disk. This is the only mechanism that works
/// when the web root is read-only, which it is on a default Windows install
/// (C:\Program Files\Jellyfin\Server\jellyfin-web).
///
/// Everything goes through reflection: Jellyfin loads each plugin into its own
/// AssemblyLoadContext, so there is no way to reference the type directly.
/// </summary>
public static class FileTransformationRegistrar
{
    private const string Marker = "/NetflixFin/netflixfin.js";

    /// <summary>
    /// Attempts to register the index.html transformation.
    /// </summary>
    /// <returns><c>true</c> when the transformation was accepted.</returns>
    public static bool TryRegister(ILogger logger)
    {
        try
        {
            var assembly = AssemblyLoadContext.All
                .SelectMany(context => context.Assemblies)
                .FirstOrDefault(asm => asm.FullName?.Contains(".FileTransformation", StringComparison.Ordinal) == true);

            if (assembly is null)
            {
                logger.LogInformation("NetflixFin: File Transformation plugin not present");
                return false;
            }

            var pluginInterface = assembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
            var register = pluginInterface?.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);

            if (register is null)
            {
                logger.LogWarning(
                    "NetflixFin: File Transformation is loaded but RegisterTransformation was not found on {Type}",
                    pluginInterface?.FullName ?? "<missing PluginInterface>");
                return false;
            }

            var payload = new
            {
                id = Plugin.Instance?.Id ?? Guid.Parse("b8e0f7c2-6b3a-4a4a-9e2f-1d5c7a9b3e41"),
                fileNamePattern = "index.html",
                callbackAssembly = typeof(FileTransformationRegistrar).Assembly.FullName,
                callbackClass = typeof(FileTransformationRegistrar).FullName,
                callbackMethod = nameof(TransformIndexHtml)
            };

            register.Invoke(null, new[] { Coerce(payload, register.GetParameters()[0].ParameterType) });

            logger.LogInformation("NetflixFin: registered index.html transformation with File Transformation");
            return true;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "NetflixFin: File Transformation registration failed");
            return false;
        }
    }

    /// <summary>
    /// Invoked by the File Transformation plugin for every index.html request.
    /// </summary>
    public static string TransformIndexHtml(object payload)
    {
        var contents = ExtractContents(payload);

        if (string.IsNullOrEmpty(contents) || contents.Contains(Marker, StringComparison.Ordinal))
        {
            return contents;
        }

        var closingBody = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        return closingBody < 0 ? contents : contents.Insert(closingBody, HtmlBlock.Build());
    }

    /// <summary>
    /// The plugin's parameter is a Newtonsoft JObject in some releases and a plain object
    /// in others; convert only when the target type asks for it.
    /// </summary>
    private static object Coerce(object payload, Type parameterType)
    {
        if (parameterType.IsInstanceOfType(payload))
        {
            return payload;
        }

        var fromObject = parameterType.GetMethod(
            "FromObject",
            BindingFlags.Public | BindingFlags.Static,
            new[] { typeof(object) });

        return fromObject?.Invoke(null, new[] { payload }) ?? payload;
    }

    /// <summary>
    /// Reads the "contents" value whether the payload is a JObject (string indexer) or an
    /// anonymous/POCO type (property).
    /// </summary>
    private static string ExtractContents(object? payload)
    {
        if (payload is null)
        {
            return string.Empty;
        }

        var type = payload.GetType();

        var indexer = type.GetMethod("get_Item", new[] { typeof(string) });
        if (indexer is not null)
        {
            var value = indexer.Invoke(payload, new object[] { "contents" });
            if (value is not null)
            {
                return value.ToString() ?? string.Empty;
            }
        }

        var property = type.GetProperty("contents") ?? type.GetProperty("Contents");
        return property?.GetValue(payload)?.ToString() ?? string.Empty;
    }
}

/// <summary>
/// The markup both injection strategies insert.
/// </summary>
internal static class HtmlBlock
{
    internal const string Start = "<!-- NetflixFin:start -->";
    internal const string End = "<!-- NetflixFin:end -->";

    /// <summary>
    /// Builds the link/script pair. The stamp changes per server start so a theme update
    /// is picked up without the browser serving a stale copy.
    /// </summary>
    internal static string Build()
    {
        return Start
            + $"<link rel=\"stylesheet\" href=\"/NetflixFin/netflixfin.css?v={Stamp}\">"
            + $"<script defer src=\"/NetflixFin/netflixfin.js?v={Stamp}\"></script>"
            + End;
    }

    private static readonly string Stamp =
        DateTime.UtcNow.Ticks.ToString("x", System.Globalization.CultureInfo.InvariantCulture);
}
