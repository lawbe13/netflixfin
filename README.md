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
