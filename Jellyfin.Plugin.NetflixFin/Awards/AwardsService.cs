using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.NetflixFin.Awards;

/// <summary>
/// Collects real Oscar / Emmy / Golden Globe / BAFTA tallies for the library and keeps them
/// in a cache on disk, so the client can badge a title without ever going to the network.
/// </summary>
/// <remarks>
/// Two sources, in this order of trust:
/// <list type="number">
/// <item>The OMDb payloads Jellyfin's own metadata provider already wrote to
/// <c>&lt;cache&gt;/omdb/{imdb}.json</c>. Their <c>Awards</c> string is IMDb-derived and
/// exact, costs nothing and needs no key — but it names only one award family per title.</item>
/// <item>Wikidata's SPARQL endpoint, which is free, keyless and complete on film awards,
/// but badly incomplete on television. Measured against this library: Titanic 11/14 and
/// Pulp Fiction 1/7, both exact; Game of Thrones 7 Emmy wins against a real 59.</item>
/// </list>
/// Because television coverage is the weak spot, the client is told to render Emmy badges
/// as a bare fact and never as a count. The failure mode is then a missing badge, never a
/// wrong one.
/// </remarks>
public sealed class AwardsService : IHostedService
{
    private const string Endpoint = "https://query.wikidata.org/sparql";

    // WDQS answers 403 to a blank, python-requests, Java or okhttp user agent. It wants a
    // real project identifier with a contact route, per its usage policy.
    private const string UserAgent =
        "NetflixFin/1.0 (+https://github.com/lawbe13/netflixfin)";

    // Parent entities. Categories hang off these by P31 *or* P361 depending on the award:
    // Oscar categories use P31, Emmy categories only ever use P361.
    private const string OscarQid = "wd:Q19020";
    private const string EmmyQid = "wd:Q1044427";
    private const string GlobeQid = "wd:Q1011547";
    private const string BaftaQid = "wd:Q732997";

    private const int ChunkSize = 300;

    private static readonly TimeSpan _maxAge = TimeSpan.FromDays(7);

    private static readonly JsonSerializerOptions _json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };

    // Both OMDb grammars share this headline clause verbatim; only the tail differs
    // ("Another 5 wins" is exclusive, "159 wins ... total" is inclusive). We read the
    // headline only, so the tail never matters. Anchored on the digits rather than on
    // sentence boundaries because real payloads exist with the separator missing
    // ("Nominated for 1 BAFTA Award8 wins & 4 nominations total").
    private static readonly Regex _headline = new(
        @"(Won|Nominated for)\s+(\d+)\s+(BAFTA Film Award|BAFTA Award|Primetime Emmy|Golden Globe|Oscar)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IApplicationPaths _appPaths;
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<AwardsService> _logger;

    private readonly ConcurrentDictionary<string, AwardRecord> _titles = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _refreshLock = new(1, 1);

    private CancellationTokenSource? _lifetime;
    private DateTime _updatedUtc = DateTime.MinValue;

    /// <summary>
    /// Initializes a new instance of the <see cref="AwardsService"/> class.
    /// </summary>
    /// <param name="httpClientFactory">The HTTP client factory.</param>
    /// <param name="appPaths">The application paths.</param>
    /// <param name="libraryManager">The library manager.</param>
    /// <param name="logger">The logger.</param>
    public AwardsService(
        IHttpClientFactory httpClientFactory,
        IApplicationPaths appPaths,
        ILibraryManager libraryManager,
        ILogger<AwardsService> logger)
    {
        _httpClientFactory = httpClientFactory;
        _appPaths = appPaths;
        _libraryManager = libraryManager;
        _logger = logger;
        Instance = this;
    }

    /// <summary>
    /// Gets the running instance, for the controller to read without a DI round trip.
    /// </summary>
    public static AwardsService? Instance { get; private set; }

    /// <summary>
    /// Gets the current tallies, keyed by IMDb ID. Titles with no awards are absent.
    /// </summary>
    public IReadOnlyDictionary<string, AwardRecord> Titles => _titles;

    /// <summary>
    /// Gets the time the cache was last rebuilt.
    /// </summary>
    public DateTime UpdatedUtc => _updatedUtc;

    private string CachePath => Path.Combine(_appPaths.CachePath, "netflixfin", "awards.json");

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Load();

        // Off the startup path on purpose: the library is not necessarily scanned yet, and
        // nothing else should wait on a third-party endpoint to boot the server.
        _ = Task.Run(
            async () =>
            {
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(45), _lifetime.Token).ConfigureAwait(false);
                    await RefreshIfStaleAsync(_lifetime.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // Shutting down.
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "NetflixFin: initial awards refresh failed");
                }
            },
            CancellationToken.None);

        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        _lifetime?.Cancel();
        _lifetime?.Dispose();
        _lifetime = null;
        return Task.CompletedTask;
    }

    /// <summary>
    /// Rebuilds the cache if it is older than a week, or missing.
    /// </summary>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task RefreshIfStaleAsync(CancellationToken cancellationToken)
    {
        if (_titles.Count > 0 && DateTime.UtcNow - _updatedUtc < _maxAge)
        {
            return;
        }

        await RefreshAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Rebuilds the cache from both sources.
    /// </summary>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task RefreshAsync(CancellationToken cancellationToken)
    {
        if (!await _refreshLock.WaitAsync(0, cancellationToken).ConfigureAwait(false))
        {
            return;
        }

        try
        {
            var ids = CollectImdbIds();
            if (ids.Count == 0)
            {
                _logger.LogInformation("NetflixFin: no IMDb IDs in the library, awards skipped");
                return;
            }

            var found = new Dictionary<string, AwardRecord>(StringComparer.OrdinalIgnoreCase);

            foreach (var pair in ReadOmdbCache(ids))
            {
                found[pair.Key] = pair.Value;
            }

            var fromOmdb = found.Count;

            for (var offset = 0; offset < ids.Count; offset += ChunkSize)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var chunk = ids.GetRange(offset, Math.Min(ChunkSize, ids.Count - offset));

                foreach (var pair in await QueryWikidataAsync(chunk, cancellationToken).ConfigureAwait(false))
                {
                    if (found.TryGetValue(pair.Key, out var existing))
                    {
                        existing.Merge(pair.Value);
                    }
                    else
                    {
                        found[pair.Key] = pair.Value;
                    }
                }
            }

            _titles.Clear();
            foreach (var pair in found)
            {
                if (!pair.Value.IsEmpty)
                {
                    _titles[pair.Key] = pair.Value;
                }
            }

            _updatedUtc = DateTime.UtcNow;
            Save();

            _logger.LogInformation(
                "NetflixFin: awards for {Found} of {Total} titles ({Omdb} from Jellyfin's OMDb cache)",
                _titles.Count,
                ids.Count,
                fromOmdb);
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    private List<string> CollectImdbIds()
    {
        var query = new InternalItemsQuery
        {
            IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
            Recursive = true
        };

        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in _libraryManager.GetItemList(query))
        {
            var imdb = item.GetProviderId(MetadataProvider.Imdb);
            if (!string.IsNullOrWhiteSpace(imdb) && imdb.StartsWith("tt", StringComparison.OrdinalIgnoreCase))
            {
                ids.Add(imdb.Trim());
            }
        }

        return ids.ToList();
    }

    /// <summary>
    /// Harvests the Awards line out of the OMDb payloads Jellyfin already cached.
    /// </summary>
    private Dictionary<string, AwardRecord> ReadOmdbCache(IEnumerable<string> ids)
    {
        var result = new Dictionary<string, AwardRecord>(StringComparer.OrdinalIgnoreCase);
        var dir = Path.Combine(_appPaths.CachePath, "omdb");
        if (!Directory.Exists(dir))
        {
            return result;
        }

        foreach (var id in ids)
        {
            var path = Path.Combine(dir, id + ".json");
            if (!File.Exists(path))
            {
                continue;
            }

            try
            {
                using var document = JsonDocument.Parse(File.ReadAllText(path));
                // Jellyfin's converter maps "N/A" to null and the serialiser then drops the
                // key entirely, so an absent Awards property means "no awards", not an error.
                if (!document.RootElement.TryGetProperty("Awards", out var awards)
                    || awards.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                var record = ParseOmdbAwards(awards.GetString());
                if (record != null)
                {
                    result[id] = record;
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "NetflixFin: could not read OMDb cache for {Id}", id);
            }
        }

        return result;
    }

    private static AwardRecord? ParseOmdbAwards(string? awards)
    {
        if (string.IsNullOrWhiteSpace(awards))
        {
            return null;
        }

        var match = _headline.Match(awards);
        if (!match.Success)
        {
            // "8 wins & 14 nominations total" - real, but it never says which awards, so
            // there is nothing here we could honestly badge.
            return null;
        }

        if (!int.TryParse(match.Groups[2].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var count)
            || count <= 0)
        {
            return null;
        }

        var won = match.Groups[1].Value.StartsWith("Won", StringComparison.OrdinalIgnoreCase);
        var family = match.Groups[3].Value;
        var record = new AwardRecord();

        if (family.StartsWith("Oscar", StringComparison.OrdinalIgnoreCase))
        {
            if (won)
            {
                record.OscarWins = count;
            }
            else
            {
                record.OscarNoms = count;
            }
        }
        else if (family.StartsWith("Primetime Emmy", StringComparison.OrdinalIgnoreCase))
        {
            if (won)
            {
                record.EmmyWins = count;
            }
            else
            {
                record.EmmyNoms = count;
            }
        }
        else if (family.StartsWith("Golden Globe", StringComparison.OrdinalIgnoreCase))
        {
            if (won)
            {
                record.GlobeWins = count;
            }
            else
            {
                record.GlobeNoms = count;
            }
        }
        else
        {
            if (won)
            {
                record.BaftaWins = count;
            }
            else
            {
                record.BaftaNoms = count;
            }
        }

        return record;
    }

    private async Task<Dictionary<string, AwardRecord>> QueryWikidataAsync(
        IReadOnlyCollection<string> ids,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, AwardRecord>(StringComparer.OrdinalIgnoreCase);

        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint);
        request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
        request.Headers.TryAddWithoutValidation("Accept", "application/sparql-results+json");
        request.Content = new FormUrlEncodedContent(
            new[] { new KeyValuePair<string, string>("query", BuildQuery(ids)) });

        var client = _httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(90);

        using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            // A timeout answers 504 with the plain text "upstream request timeout", not JSON.
            _logger.LogWarning(
                "NetflixFin: Wikidata answered {Status} for a batch of {Count} titles",
                (int)response.StatusCode,
                ids.Count);
            return result;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        using var document = JsonDocument.Parse(body);

        if (!document.RootElement.TryGetProperty("results", out var results)
            || !results.TryGetProperty("bindings", out var bindings))
        {
            return result;
        }

        foreach (var row in bindings.EnumerateArray())
        {
            var imdb = Value(row, "imdb");
            if (string.IsNullOrEmpty(imdb))
            {
                continue;
            }

            result[imdb] = new AwardRecord
            {
                OscarWins = Number(row, "ow"),
                OscarNoms = Number(row, "on"),
                EmmyWins = Number(row, "ew"),
                EmmyNoms = Number(row, "en"),
                GlobeWins = Number(row, "gw"),
                GlobeNoms = Number(row, "gn"),
                BaftaWins = Number(row, "bw"),
                BaftaNoms = Number(row, "bn")
            };
        }

        return result;
    }

    private static string? Value(JsonElement row, string name) =>
        row.TryGetProperty(name, out var cell) && cell.TryGetProperty("value", out var value)
            ? value.GetString()
            : null;

    private static int Number(JsonElement row, string name) =>
        int.TryParse(Value(row, name), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : 0;

    /// <summary>
    /// Builds the batched SPARQL query.
    /// </summary>
    /// <remarks>
    /// Awards reach a title two ways and both have to be asked for: on the work itself
    /// (P166 / P1411), and on a person whose award statement points back at the work
    /// through the P1686 "for work" qualifier — that second path is the only way Best
    /// Director or Best Actor is reachable. The two paths overlap heavily, hence the
    /// DISTINCT subquery: a raw union returns 18 rows for Pulp Fiction's 1 win and 7
    /// nominations.
    ///
    /// The category filter is a single hop, <c>P31|P361</c>. Walking <c>P279*</c> instead
    /// climbs into generic ontology classes and times the query out at 65 seconds.
    /// </remarks>
    private static string BuildQuery(IEnumerable<string> ids)
    {
        var values = new StringBuilder();
        foreach (var id in ids)
        {
            // The IDs come from Jellyfin's provider fields, but they end up inside a SPARQL
            // literal, so keep anything but the known-good shape out of the query.
            if (IsWellFormed(id))
            {
                values.Append('"').Append(id).Append("\" ");
            }
        }

        return
            "SELECT ?imdb" +
            " (SUM(IF(?f=\"oscar\"&&?k=\"win\",1,0)) AS ?ow) (SUM(IF(?f=\"oscar\"&&?k=\"nom\",1,0)) AS ?on)" +
            " (SUM(IF(?f=\"emmy\"&&?k=\"win\",1,0)) AS ?ew) (SUM(IF(?f=\"emmy\"&&?k=\"nom\",1,0)) AS ?en)" +
            " (SUM(IF(?f=\"globe\"&&?k=\"win\",1,0)) AS ?gw) (SUM(IF(?f=\"globe\"&&?k=\"nom\",1,0)) AS ?gn)" +
            " (SUM(IF(?f=\"bafta\"&&?k=\"win\",1,0)) AS ?bw) (SUM(IF(?f=\"bafta\"&&?k=\"nom\",1,0)) AS ?bn)" +
            " WHERE { { SELECT DISTINCT ?imdb ?f ?k ?award WHERE {" +
            " VALUES ?imdb { " + values + "}" +
            " VALUES (?parent ?f) { (" + OscarQid + " \"oscar\") (" + EmmyQid + " \"emmy\")" +
            " (" + GlobeQid + " \"globe\") (" + BaftaQid + " \"bafta\") }" +
            " ?w wdt:P345 ?imdb ." +
            " { ?w wdt:P166 ?award . BIND(\"win\" AS ?k) }" +
            " UNION { ?w wdt:P1411 ?award . BIND(\"nom\" AS ?k) }" +
            " UNION { ?p p:P166 ?s . ?s ps:P166 ?award ; pq:P1686 ?w . BIND(\"win\" AS ?k) }" +
            " UNION { ?p p:P1411 ?s . ?s ps:P1411 ?award ; pq:P1686 ?w . BIND(\"nom\" AS ?k) }" +
            " ?award wdt:P31|wdt:P361 ?parent ." +
            " } } } GROUP BY ?imdb";
    }

    private static bool IsWellFormed(string id)
    {
        if (id.Length < 3 || id.Length > 16 || !id.StartsWith("tt", StringComparison.Ordinal))
        {
            return false;
        }

        for (var i = 2; i < id.Length; i++)
        {
            if (!char.IsAsciiDigit(id[i]))
            {
                return false;
            }
        }

        return true;
    }

    private void Load()
    {
        try
        {
            var path = CachePath;
            if (!File.Exists(path))
            {
                return;
            }

            var cache = JsonSerializer.Deserialize<AwardsCache>(File.ReadAllText(path), _json);
            if (cache?.Titles == null)
            {
                return;
            }

            foreach (var pair in cache.Titles)
            {
                _titles[pair.Key] = pair.Value;
            }

            _updatedUtc = cache.UpdatedUtc;
            _logger.LogInformation("NetflixFin: loaded awards for {Count} titles", _titles.Count);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "NetflixFin: could not read the awards cache");
        }
    }

    private void Save()
    {
        try
        {
            var path = CachePath;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var cache = new AwardsCache
            {
                UpdatedUtc = _updatedUtc,
                Titles = new Dictionary<string, AwardRecord>(_titles, StringComparer.OrdinalIgnoreCase)
            };
            File.WriteAllText(path, JsonSerializer.Serialize(cache, _json));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "NetflixFin: could not write the awards cache");
        }
    }

    private sealed class AwardsCache
    {
        public DateTime UpdatedUtc { get; set; }

        public Dictionary<string, AwardRecord>? Titles { get; set; }
    }
}
