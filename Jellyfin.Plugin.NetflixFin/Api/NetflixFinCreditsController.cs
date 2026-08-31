using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Chapters;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Model.Configuration;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.NetflixFin.Api;

/// <summary>
/// Where each title's closing credits begin, for every title where cutting them is
/// provably safe. The channels end a programme there instead of sitting through the
/// roll, which on this library is eighteen hours of film and thirty-four of television.
/// </summary>
/// <remarks>
/// A controller of its own, not another action on <see cref="NetflixFinController"/>.
/// That one is [AllowAnonymous] at class level so the login page can fetch the stylesheet
/// before a token exists, and in ASP.NET Core an AllowAnonymous anywhere on the endpoint
/// beats an action-level [Authorize] - so this could not be protected if it lived there.
/// It lists the id of every film and episode in the library, so it is worth protecting.
/// </remarks>
[ApiController]
[Route("NetflixFin")]
[Authorize]
public class NetflixFinCreditsController : ControllerBase
{
    private const long Second = 10000000L;

    /// <summary>
    /// The keywords TMDb uses for a scene in or after the credits. Jellyfin stores them
    /// as tags. Nothing else in this library's four thousand tag values contains either
    /// "sting" or "credit" except "corvette stingray" and "credit card fraud", so an
    /// exact match cannot fire by accident.
    /// </summary>
    private static readonly HashSet<string> Stingers = new(StringComparer.OrdinalIgnoreCase)
    {
        "aftercreditsstinger",
        "duringcreditsstinger",
        "beforecreditsstinger"
    };

    private static readonly MediaSegmentType[] OutroOnly = { MediaSegmentType.Outro };

    /// <summary>
    /// A chapter that names the closing credits, and only that. "Credits" on its own,
    /// "Main Titles", "Opening Credits" and "Sigla Iniziale" are all in this library and
    /// all sit at zero seconds - matching any of them would cut a film to nothing.
    /// </summary>
    private static readonly Regex EndCredits = new(
        @"(?:\b(?:end|closing|final)\b[\s\-_,:]*(?:credits?|titles?)\b)"
        + @"|\bend[-_]credits?\b|\bsigla\s+finale\b|\btitoli\s+di\s+coda\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// A chapter that names a scene as well as the credits - "Sunset and End Credits" -
    /// starts at the scene, a minute or two before the roll. Refused.
    /// </summary>
    private static readonly Regex SceneAndCredits = new(
        @"[,&]\s*end\s+(?:credits?|titles?)|\band\s+end\s+(?:credits?|titles?)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /* filterByProvider: false never reads this, but the parameter is not nullable and a
       later patch might, so it gets a real empty object rather than a null. */
    private static readonly LibraryOptions NoOptions = new();

    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(30);

    private static Dictionary<string, long>? _map;
    private static string? _tag;
    private static DateTime _builtUtc;

    private readonly IMediaSegmentManager _segments;
    private readonly ILibraryManager _library;
    private readonly IChapterManager _chapters;

    /// <summary>
    /// Initializes a new instance of the <see cref="NetflixFinCreditsController"/> class.
    /// </summary>
    /// <param name="segments">Where the closing credits are.</param>
    /// <param name="library">Everything that might have some.</param>
    /// <param name="chapters">What else is marked in the file.</param>
    public NetflixFinCreditsController(
        IMediaSegmentManager segments,
        ILibraryManager library,
        IChapterManager chapters)
    {
        _segments = segments;
        _library = library;
        _chapters = chapters;
    }

    /// <summary>
    /// Gets, for every title where the cut is safe, the millisecond at which its closing
    /// credits begin. Keyed by item id without dashes, which is the form the client holds.
    /// </summary>
    /// <param name="refresh">Builds the map again instead of answering from the cache.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The map.</returns>
    [HttpGet("tv/credits")]
    [Produces("application/json")]
    public async Task<ActionResult> GetCredits(
        [FromQuery] bool refresh = false,
        CancellationToken cancellationToken = default)
    {
        var built = await BuildAsync(refresh, cancellationToken).ConfigureAwait(false);

        Response.Headers.ETag = built.Tag;
        Response.Headers.CacheControl = "private, max-age=300";

        if (Request.Headers.IfNoneMatch.Count > 0
            && Request.Headers.IfNoneMatch.ToString().Contains(built.Tag, StringComparison.Ordinal))
        {
            return StatusCode(StatusCodes.Status304NotModified);
        }

        return new JsonResult(built.Map);
    }

    private async Task<(Dictionary<string, long> Map, string Tag)> BuildAsync(
        bool refresh,
        CancellationToken cancellationToken)
    {
        if (!refresh && _map is not null && DateTime.UtcNow - _builtUtc < Ttl)
        {
            return (_map, _tag!);
        }

        /* One at a time: the walk is a few seconds and a page load can easily ask twice. */
        await Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!refresh && _map is not null && DateTime.UtcNow - _builtUtc < Ttl)
            {
                return (_map, _tag!);
            }

            var map = new Dictionary<string, long>(StringComparer.Ordinal);

            var items = _library.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Episode },
                Recursive = true,
                IsVirtualItem = false
            });

            /* This library holds the same file twice.
             *
             * 676 films under one root and 160 under another, of which 159 are
             * the same file again - 677 titles in 836 rows. Only one of the two
             * copies has usually been analysed, and which copy a channel picks
             * is decided by the shuffle, so the same film was cut one evening
             * and sat through the next. Copies share what either of them knows.
             *
             * Same file name and same size, not the same title: two different
             * cuts of a film are two different files and must not swap credits.
             * Where both copies have been analysed and disagree, the later start
             * wins - the one that cuts least. */
            var known = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
            var found = new List<(BaseItem Item, string Twin, long Start)>(items.Count);

            foreach (var item in items)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var start = await OwnMarkAsync(item).ConfigureAwait(false);
                var twin = TwinOf(item);

                found.Add((item, twin, start));

                if (start > 0 && twin is not null
                    && (!known.TryGetValue(twin, out var seen) || start > seen))
                {
                    known[twin] = start;
                }
            }

            foreach (var (item, twin, own) in found)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var start = own;
                if (start <= 0 && twin is not null)
                {
                    known.TryGetValue(twin, out start);
                }

                if (start > 0 && Allowed(item, start))
                {
                    map[item.Id.ToString("N", CultureInfo.InvariantCulture)] = start / (Second / 1000);
                }
            }

            _map = map;
            _builtUtc = DateTime.UtcNow;
            _tag = "\"" + map.Count.ToString(CultureInfo.InvariantCulture) + "-"
                + _builtUtc.Ticks.ToString(CultureInfo.InvariantCulture) + "\"";
            return (map, _tag);
        }
        finally
        {
            Gate.Release();
        }
    }

    /// <summary>
    /// What makes two rows the same file: its name and how long it runs. Null when
    /// either is missing, which means the row shares with nobody.
    /// </summary>
    /// <remarks>
    /// Strict on purpose. Two cuts of the same film are two files with the same name
    /// and different lengths, and they must not swap credits. On this library the pair
    /// picks out exactly the same 1306 groups as the file name and byte size do.
    /// </remarks>
    private static string? TwinOf(BaseItem item)
    {
        var path = item.Path;
        var runtime = item.RunTimeTicks ?? 0;
        if (string.IsNullOrEmpty(path) || runtime <= 0)
        {
            return null;
        }

        var name = System.IO.Path.GetFileName(path);
        return string.IsNullOrEmpty(name)
            ? null
            : name + "|" + runtime.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Where this title's credits begin according to its own segment, in ticks, or
    /// zero when the file does not say. The rest of the rule is in
    /// <see cref="Allowed(BaseItem, long)"/>, because a copy that inherits the time
    /// from its twin has to pass it too.
    /// </summary>
    /// <remarks>
    /// Everything here refuses rather than guesses, because ending a film in the wrong
    /// place is much worse than sitting through its credits. Written out, the rule is:
    /// the file must carry a closing-credits segment; that segment must run to the end of
    /// the file, so nothing is left after it; it must begin late enough and cut little
    /// enough to be a credit roll rather than an act; nothing may be marked in the file
    /// after it begins; and for a film, the metadata must be there to say there is no
    /// scene in the credits - which for an episode it never is, so an episode is held to
    /// the shape of the segment alone and to a much later start.
    /// </remarks>
    private async Task<long> OwnMarkAsync(BaseItem item)
    {
        var fromFile = await SegmentStartAsync(item).ConfigureAwait(false);
        if (fromFile > 0 && Allowed(item, fromFile))
        {
            return fromFile;
        }

        /* The segment provider has looked at all 677 films here and found the credits on
         * 301 of them; on the rest it simply did not see them, and running it again finds
         * nothing new. Where somebody has named a chapter, that name is the answer: of the
         * 28 films that have both, 26 agree with the segment to the exact tick, and the
         * two that do not are films whose segment is a two-second stub at the end of the
         * file - Final Destination 2 and 3 - where the chapter is right and the segment is
         * wrong. It is a second opinion, not a worse one. */
        var fromChapter = ChapterMark(item);
        return fromChapter > 0 && Allowed(item, fromChapter) ? fromChapter : 0;
    }

    /// <summary>
    /// Where a named chapter says the closing credits begin, or zero.
    /// </summary>
    /// <remarks>
    /// It must be the LAST chapter of the file. That one condition is what keeps a post-
    /// credit scene: Pecore sotto copertura has End Credits as chapter 53 of 56, and the
    /// three that follow it are the scenes after the roll.
    /// </remarks>
    private long ChapterMark(BaseItem item)
    {
        var runtime = item.RunTimeTicks ?? 0;
        if (runtime <= 0)
        {
            return 0;
        }

        IReadOnlyList<MediaBrowser.Model.Entities.ChapterInfo> marked;
        try
        {
            marked = _chapters.GetChapters(item.Id);
        }
        catch (Exception)
        {
            return 0;
        }

        if (marked is null || marked.Count == 0)
        {
            return 0;
        }

        var last = marked[marked.Count - 1];
        var name = last.Name ?? string.Empty;

        if (!EndCredits.IsMatch(name) || SceneAndCredits.IsMatch(name))
        {
            return 0;
        }

        return last.StartPositionTicks < (long)(runtime * 0.85) ? 0 : last.StartPositionTicks;
    }

    private async Task<long> SegmentStartAsync(BaseItem item)
    {
        var runtime = item.RunTimeTicks ?? 0;
        if (runtime <= 0)
        {
            return 0;
        }

        IEnumerable<MediaBrowser.Model.MediaSegments.MediaSegmentDto> found;
        try
        {
            /* filterByProvider defaults to true, and when it is true the stored segments
               disappear the moment no provider is registered - which would quietly turn
               the whole feature off rather than break it loudly. What is on disk is what
               is asked for. */
            found = await _segments
                .GetSegmentsAsync(item, OutroOnly, NoOptions, filterByProvider: false)
                .ConfigureAwait(false);
        }
        catch (Exception)
        {
            return 0;
        }

        var outro = found?.OrderBy(s => s.StartTicks).FirstOrDefault();
        if (outro is null || outro.StartTicks <= 0)
        {
            return 0;
        }

        // Nothing may follow the credits in the file itself.
        if (outro.EndTicks < runtime - (2 * Second))
        {
            return 0;
        }

        return outro.StartTicks;
    }

    /// <summary>
    /// Whether this title may be cut at <paramref name="start"/> - everything the
    /// decision needs that is not the segment itself, so it holds for a copy that
    /// inherited the time from its twin as well as for the one that was analysed.
    /// </summary>
    private bool Allowed(BaseItem item, long start)
    {
        var runtime = item.RunTimeTicks ?? 0;
        if (runtime <= 0 || start <= 0)
        {
            return false;
        }

        var film = item is MediaBrowser.Controller.Entities.Movies.Movie;
        var cut = runtime - start;

        if (film)
        {
            if (start < runtime / 2) return false;
            if (cut < 45 * Second || cut > 20 * 60 * Second) return false;

            /* An episode carries no keywords at all, so for a film - and only for a film -
               their absence is evidence rather than a gap in the record. */
            var tags = item.Tags ?? Array.Empty<string>();
            if (tags.Length == 0) return false;
            if (tags.Any(Stingers.Contains)) return false;

            /* Asked for by name. It costs a handful of films that keep credits they did
               not need, and it is the one arm that still works on a title TMDb has not
               got round to. */
            var studios = item.Studios ?? Array.Empty<string>();
            if (studios.Any(s => s.Contains("marvel", StringComparison.OrdinalIgnoreCase)))
            {
                return false;
            }
        }
        else
        {
            /* Twenty minutes of a forty-minute episode has been marked as its credits in
               this library, so an episode has to start much later to be believed. */
            if (start < (long)(runtime * 0.85)) return false;
            if (cut < 20 * Second || cut > 5 * 60 * Second) return false;
        }

        // Somebody marked something after the credits began: whatever it is, keep it.
        var marked = _chapters.GetChapters(item.Id);
        if (marked is not null && marked.Any(c => c.StartPositionTicks > start + (30 * Second)))
        {
            return false;
        }

        return true;
    }
}
