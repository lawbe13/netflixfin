# NetflixFin

A Jellyfin plugin that reshapes the web client after Netflix: a rotating hero banner,
16:9 rows that expand on hover, pill-shaped action buttons, Top 10 rank numerals and a
header that fades from transparent to solid as you scroll.

Unlike a pasted stylesheet, the plugin re-applies itself after every jellyfin-web update
and exposes its options on a dashboard page.

> Not affiliated with Netflix. No Netflix artwork, fonts or trademarks are redistributed
> here — the theme reproduces layout and colour proportions only, and falls back to the
> system UI font.

## Requirements

| | |
|---|---|
| Jellyfin server | 10.11.x (`targetAbi 10.11.0.0`, `net9.0`) |
| Write access | the plugin patches `index.html` in the web root at start-up |

If your web root is read-only (some hardened container images), use the
[custom CSS fallback](#custom-css-only) instead.

## Install

Add the plugin repository in **Dashboard → Plugins → Repositories**:

```
https://raw.githubusercontent.com/lawbe13/netflixfin/main/manifest.json
```

Then install **NetflixFin** from the catalogue and restart Jellyfin.

Remove any other theme from **Dashboard → General → Custom CSS** first — NetflixFin is a
complete skin and will fight with ElegantFin, JellySkin, Ultrachromic and friends.

## Living with other plugins

NetflixFin injects through the
[File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)
plugin when it is installed, and falls back to patching `index.html` otherwise. On a
default Windows install the web root is under `C:\Program Files` and is not writable by
the service account, so **File Transformation is effectively required there**.

If another plugin already renders a home-screen hero (Media Bar Enhanced, Jellyfin
Enhanced), NetflixFin's own hero stands down rather than stacking a second one on top.

### Restart properly after installing or updating

Jellyfin's **Restart** button (and `POST /System/Restart`) rebuilds the host in the same
process. File Transformation keeps its registrations in static state across that, so the
old registration survives holding a service provider that has since been disposed, and
every subsequent request for `index.html` fails:

```
System.ObjectDisposedException: Cannot access a disposed object.
Object name: 'IServiceProvider'.
   at Jellyfin.Plugin.FileTransformation.PluginInterface...RegisterTransformation
```

The web client then answers **500** until the process itself is restarted. This affects
any plugin that injects through File Transformation, not just this one. After installing
or updating one, quit Jellyfin from the tray (or restart the service) rather than using
the in-app restart.

## Configuration

**Dashboard → Plugins → NetflixFin**

| Option | Default | Notes |
|---|---|---|
| Hero banner | on | Random backdrop-bearing titles from your libraries |
| Rotate hero | on, 12s | |
| Expand cards on hover | on | Disabled automatically on touch devices |
| Hide titles under cards | on | Titles move into the hover overlay |
| 16:9 backdrops in rows | on | Falls back to the poster when an item has no backdrop |
| Top 10 numerals | on | Applies to any row whose title matches `top 10` |
| Accent / background colour | `#E50914` / `#141414` | |
| Card corner radius | 6px | Netflix uses ~12px on a 248px-wide card |
| Header logo URL | empty | Any URL or `data:` URI |
| Extra CSS | empty | Appended after the theme |

Changes need a hard refresh in the browser (Ctrl+Shift+R).

## How it works

* `Api/NetflixFinController.cs` serves `/NetflixFin/netflixfin.css` and
  `/NetflixFin/netflixfin.js`, both anonymous so the login page can use them. The
  stylesheet is prefixed with a `:root` block carrying the configured tokens; the script
  is prefixed with the configuration as JSON.
* `Injection/InjectionService.cs` inserts a `<link>` and a `<script>` before `</body>` in
  `index.html`, wrapped in `<!-- NetflixFin:start -->` / `<!-- NetflixFin:end -->`
  markers. The block is rewritten on every start (so it survives client updates, with a
  fresh cache-busting stamp) and removed again on graceful shutdown.
* The CSS carries the whole look. The script only adds what CSS cannot express: the hero
  banner, the rank numerals, the poster→backdrop swap, and the scrolled-header flag.
  If the script fails, the theme degrades to a static Netflix-coloured skin.

## Award badges

The billboard badges a title that really has won or been nominated for an Academy Award,
a Primetime Emmy, a Golden Globe or a BAFTA. Nothing is inferred and nothing is invented:
titles without an award simply carry no badge, which on a 744-title library came out at
231 badged.

Jellyfin stores no award data of its own, so `Awards/AwardsService.cs` assembles it from
two keyless sources and caches the result under `<cache>/netflixfin/awards.json`, refreshed
weekly:

* **Jellyfin's own OMDb cache.** The OMDb metadata provider writes its full payload to
  `<cache>/omdb/{imdb}.json`, and that payload carries an IMDb-derived `Awards` string it
  then discards rather than mapping onto the item. Free, local, exact — but it names only
  one award family per title.
* **Wikidata.** `query.wikidata.org/sparql`, batched, roughly a second per 300 titles.

The two are merged per family by taking the larger count, because they disagree by
omission rather than by contradiction.

The badge states the fact and never the count — "Premiato agli Oscar®", not "Winner of 11
Oscars" — matching Netflix, and for a good reason: Wikidata is exact on film awards
(Titanic 11 wins / 14 nominations, Pulp Fiction 1 / 7) but thin on television, holding 7
of Game of Thrones' 59 Emmy wins and none of Rick and Morty's two. A bare fact degrades to
a missing badge; a number would have degraded to a wrong one. The tallies are in the pill's
tooltip for anyone who wants them.

## Billboard trailer

After a configurable pause the billboard swaps its artwork for the title's trailer,
muted, with a mute toggle top right. The synopsis folds away as it starts, and because
the copy column is anchored to the bottom of the card the metadata line and the logo
drop toward the buttons on their own. Rotation holds until the trailer ends.

Jellyfin's metadata providers record trailers as YouTube links — 591 of 744 titles on
the library this was built against, and no local trailer files at all — so the player is
a YouTube embed. It is chrome-free, oversized 15% so the title bar and watermark fall
outside the crop, and `pointer-events: none`, so every click still belongs to the
billboard.

Three things it has to survive, all of them observed rather than guessed:

* **Jellyfin sets `<meta name="referrer" content="no-referrer">`.** YouTube rejects an
  embed that arrives with no referrer at all — *Error 153, video player configuration
  error* — so the iframe carries its own `referrerpolicy`.
* **Some trailers are not embeddable.** The link answers `onError 150` and the billboard
  keeps its artwork. One in twenty-four sampled titles was blocked this way.
* **The video is revealed only when the player reports that it is playing.** Buffering, a
  dead link, or a tab the browser has backgrounded and refuses to decode media in all
  leave the artwork exactly where it is. A trailer that starts late appears late; one
  that never starts is never seen.

Turn it off, or change the pause, under **Dashboard → Plugins → NetflixFin**.

## The tab bar on phone and iPad

Below 1280px the header's navigation moves into a floating capsule at the bottom, with
Home, Cerca and a third entry pointing at your favourites — which live on tab 1 of the
home page, not on a route of their own.

This is the one part of the skin that is deliberately not Netflix. Netflix draws a flat
`#222` bar with a `#2d2d2d` pill behind the active tab; this is liquid glass, carried
across from another project on request, after Vadim Matveev's *Liquid Glass Switcher*:
the same stack of inner shadows in `color-mix`, a drop that travels under the labels, a
shrink to icons-only as you scroll down, and a drag. The SVG refraction filter is left
out, because iOS `backdrop-filter` does not accept `url()`.

The drop's position and width are driven by a damping loop rather than a CSS transition.
The target moves: when the capsule resizes the entries shift while the drop is still in
flight, so a transition would aim at where the entry used to be. The loop re-measures
every frame, and a `ResizeObserver` on the capsule catches the two changes nothing else
reports — the bar being measured before it is on screen, and the web font swapping in.

## Custom CSS only

Without installing anything, paste this into **Dashboard → General → Custom CSS**:

```css
@import url("https://cdn.jsdelivr.net/gh/lawbe13/netflixfin@main/Jellyfin.Plugin.NetflixFin/Web/netflixfin.css");
```

You lose the hero banner, the Top 10 numerals and the 16:9 swap — everything else applies.

## Build

No local checkout of Jellyfin is needed; the project references the published NuGets.

```bash
dotnet publish Jellyfin.Plugin.NetflixFin/Jellyfin.Plugin.NetflixFin.csproj -c Release -o publish
```

Copy `publish/Jellyfin.Plugin.NetflixFin.dll` into
`<jellyfin-data>/plugins/NetflixFin_1.0.0.0/` and restart.

Tagging `v1.0.1.0` runs `.github/workflows/release.yml`, which builds the package with
[jprm](https://github.com/oddstr13/jellyfin-plugin-repository-manager), updates
`manifest.json` and publishes the GitHub release.

## Design reference

Values were measured from `netflix.com/browse` at a 1920px viewport:

| | |
|---|---|
| Page background | `#141414` |
| Accent | `#E50914` |
| Page gutter | 60px |
| Gap between cards | 8px |
| Card | 248 × 139 (16:9), 12px radius |
| Row title | 24px / weight 500 |
| Header | 80px, `linear-gradient(rgba(0,0,0,.8), transparent)` |
| Nav links | 16px, active `#fff`, idle `rgba(255,255,255,.7)` |
| Primary button | white fill, black label, fully rounded |
| Secondary button | `rgba(128,128,128,.4)`, white label |

## Licence

MIT
