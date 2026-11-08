# Nuvio Live

A fork of [NuvioMedia/NuvioTVSmart](https://github.com/NuvioMedia/NuvioTVSmart) that adds a Live TV / IPTV
section: Xtream and M3U providers, a TiviMate-style guide with a live preview, zapping, catch-up, and a
Favourite channels row on Home. Behaviour and parsing logic are ported from
[homelessbrian/NuvioPlusIPTV](https://github.com/homelessbrian/NuvioPlusIPTV) (Android/Kotlin). Both
projects are GPL-3.0, and so is this fork. Each ported module names the Kotlin file it came from.

The plan and phase checkpoints are in [LIVE_TV_PLAN.md](LIVE_TV_PLAN.md).

## Using it

| Where              | Remote                 | Does                                                                        |
| ------------------ | ---------------------- | --------------------------------------------------------------------------- |
| Guide              | Up / Down              | Channels                                                                    |
|                    | Left / Right           | Programmes in time (past ones only on catch-up channels)                    |
|                    | OK                     | Live programme: watch. Past programme: catch-up. Future: shows start time   |
|                    | Hold OK                | Add / remove favourite                                                      |
|                    | CH + / CH -            | A page of channels                                                          |
|                    | Up from the top row    | Group tabs (Favourites, Recent, All channels, groups, Providers & settings) |
|                    | Back                   | Channel column, then the sidebar                                            |
| Watching a channel | CH + / CH -, Up / Down | Next / previous channel in the group you came from (wraps round)            |
|                    | OK                     | Channel banner (now / next); OK again: channel list                         |
|                    | Left                   | Channel list over the video                                                 |
|                    | Right                  | The player's own controls (audio, subtitles, ...)                           |
|                    | Back                   | Back to the guide, on the channel you were watching                         |
| Home               | OK on a channel        | Watch it; CH +/- moves through your favourites                              |

Favourites, recently watched channels and the last group are per profile. Providers and settings are shared
by every profile and stay on the TV (not synced to the Nuvio account).

Settings live under **Live TV → Providers & settings** (also **Settings → Live TV**): refresh, remove, guide
days ahead / back, refresh interval, preview on/off, the Home row, 24-hour clock, hiding groups, and a
User-Agent per provider (presets, for providers that block unknown players).

**Test pattern channel** (off by default) adds a "Test pattern" channel at the top of the list: a 1920×1080
video with rulers along every edge (1 % ticks, labels every 10 %), coloured edges (red top, green bottom,
blue left, yellow right), a circle that should look round, and a running clock. Use it to see how much of
the picture the preview or the full-screen player shows. The video is `services/livetv-test-pattern.mp4`,
served by the plugin service at `/livetv-test-pattern.mp4`.

## Installs alongside official Nuvio

|                  | Official Nuvio       | Nuvio Live              |
| ---------------- | -------------------- | ----------------------- |
| App name         | Nuvio TV             | Nuvio Live              |
| Tizen package id | `NuvioTV001`         | `NuvioLv001`            |
| Tizen app id     | `NuvioTV001.NuvioTV` | `NuvioLv001.NuvioLive`  |
| Widget id        | `https://nuvio.tv`   | `https://nuvio.tv/live` |

Build the package with `npm run package:tizen`; it writes `NuvioLv001_<version>.wgt` to the repo root.

Upstream doesn't commit the service keys (Nuvio account, TMDB, Trakt, Simkl, …). Without a
`local.properties` the build falls back to `local.example.properties` and those features don't work. For a
personal build, put the values in a gitignored `local.properties` (same names as
`local.example.properties`). Never commit it.

### Installing with the Nuvio TV Installer

The stock installer works; no installer fork is needed. Choose **Samsung → Custom**, **Browse** to the
`NuvioLv001_<version>.wgt`, and press **Install**. The installer reads the package and app id from the WGT's
`config.xml`, keeps a valid 10-character package id as it is, and re-signs it with the Samsung identity it
saved for the TV when official Nuvio was installed.

Don't use the installer's **Uninstall**, **Launch** or **Logs** buttons for Nuvio Live: those always act on the
ids in the installer's `installer.config.json`, which are official Nuvio's. Remove Nuvio Live from the TV's
own Apps screen instead.

## Adding a provider

Live TV (sidebar) → **Add a provider from your phone** shows a QR code. The phone opens a small page served
by the TV itself (`services/livetv-setup.cjs`, port 2712–2715, only while that screen is open, closed after
10 minutes or 60 seconds without the app polling it), and the details go straight to the TV over the home
network. The address has a random 12-character code in it. Nothing is logged, and nothing leaves the home
network. The app starts, polls and stops that page through the loopback plugin service (`POST
/livetv-setup` on 2711), the same way upstream's custom poster phone page works.

**Type it on the TV instead** is the fallback: the same fields, typed with the TV's on-screen keyboard. For
Xtream, the whole `get.php?username=…&password=…` link can go in the Server field.

Official Nuvio and Nuvio Live both run their plugin service on port 2711 (the installer requires that port),
and only one can hold it. If official Nuvio's service is still running, the setup page can't start and the
TV says so; turning the TV off and on fixes it.

## How it works

```
js/livetv/
  model.js                  sources (Xtream / M3U), link clean-up        <- LiveTvModels.kt
  liveTvRepository.js       load, refresh, guide runs, now/next, links   <- LiveTvRepository.kt, LiveTvViewModel.kt
  liveTvPlayback.js         player params, catch-up, guide preview       <- LiveTvPlaybackController.kt (rules)
  data/
    xtreamClient.js         player_api.php, stream / xmltv links         <- LiveTvRepository.kt (Xtream)
    m3uParser.js            #EXTINF, url-tvg, catch-up attributes        <- M3uParser.kt
    xmltvParser.js          incremental (chunked) XMLTV parser           <- XmltvParser.kt
    guideLoader.js          download -> gunzip (pako) -> parse -> IndexedDB, in chunks
    guideMatching.js        tvg-id, then normalised name                 <- LiveTvRepository.kt (normalize, idName)
    catchupUrl.js           Xtream timeshift, flussonic, shift, templates <- CatchupUrlBuilder.kt
    liveTvDb.js, channelStore.js, epgStore.js   IndexedDB                <- LiveTvChannelStore.kt, EpgDatabase.kt
    sourceStore.js, liveTvPreferences.js        LocalStore (sources, settings, per-profile state)
    liveTvHttp.js           direct fetch, else the loopback pass-through
  setup/phoneSetupSession.js
js/ui/screens/livetv/
  liveTvScreen.js + liveTvScreenMethods-0N-*.js  the Live TV screen (guide, providers, settings)
  guideModel.js             grid maths (cells, ruler, focus steps, tabs)  <- LiveTvGuideScreen.kt, GuideRowStrip.kt
  livePlayerHooks.js        zapping, banner, channel list, fallback, Back <- LiveTvPlayerPanel.kt, LiveTvOverlayMode.kt
  liveHomeHooks.js          Home "Favourite channels" row                 <- LiveTvHomeRow.kt
services/livetv-setup.cjs   phone setup page (LAN, while open)
services/livetv-proxy.cjs   loopback pass-through: CORS, User-Agent, streamed (no size limit); test pattern video
```

- **Playback** goes through the app's PlayerScreen (AVPlay / hls.js, its proxy for headers). A channel is
  launched without `itemId`/`videoId`, so it is never scrobbled, saved as progress or looked up in addons.
  Xtream links are tried in the account's format, then the other (`.ts` ↔ `.m3u8`), after one retry.
- **Player and Home changes are hooks**, installed once from `router.js` (`installLivePlayerHooks`,
  `installLiveHomeHooks`): they wrap a few PlayerScreen / HomeScreen methods and do nothing for other
  content, so no player or Home file had to change.
- **The guide preview** drives PlayerController directly: the player screen becomes a transparent layer
  over the guide with the video (AVPlay's object, or the video element for hls.js) in the preview's
  rectangle. It starts after focus rests on a channel for 1 s (so scrolling past channels doesn't open a stream for each), and can be turned off in settings.
  AVPlay uses `PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO` for the preview: with `…_FULL_SCREEN` the 2025
  Frame (Tizen 9) ignores the rectangle and draws the whole screen behind the box. The player's own
  display mode is put back when the preview stops.
- **The guide** is read on launch when older than the refresh interval, and on demand. Programmes are kept
  from "days back" to "days ahead" and pruned after each run. Parsing runs on the main thread in chunks
  that yield to the UI (simpler than a Web Worker in this build, and quick enough for a few hundred
  channels); about 37 MB/s in Node, expect several times slower on a TV.

## Development

- `npm run test:livetv` runs the Live TV tests (parsers, catch-up, matching, grid maths, setup server,
  pass-through).
- Desktop: `npm run serve` has no TV plugin service. Provider requests work directly when the provider
  sends CORS headers (a local fake provider can). To try the phone setup, start `services/plugin-http.cjs`
  on 127.0.0.1:2711 with Node and set `window.__NUVIO_LIVETV_SETUP_PORT__ = 2711` in the console before
  opening Live TV.
- `window.__NUVIO_DEBUG_LIVETV__ = true` (before opening Live TV / the player) exposes the screens as
  `window.__nuvioLiveTvScreen` and `window.__nuvioPlayerScreen` for poking at state.

## Upstream files touched

Keep this list complete so rebasing onto upstream stays easy. New code lives in `js/livetv/`,
`js/ui/screens/livetv/`, `js/ui/screens/settings/settingsLiveTvSection.js`, `css/livetv*.css`,
`services/livetv-*.cjs` and `scripts/test-livetv-*.mjs`.

| File                                                                 | Why                                                                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `scripts/package-tizen.mjs`                                          | App name, Tizen ids and widget id; packages `services/livetv-*` (requires the `.cjs` files).                               |
| `services/plugin-http.cjs`                                           | Loopback routes `POST /livetv-setup` (phone setup), `GET /livetv-proxy` (pass-through) and `GET /livetv-test-pattern.mp4`. |
| `js/ui/navigation/router.js`                                         | Registers the `liveTv` route; installs the player and Home hooks.                                                          |
| `js/bootstrap/renderAppShell.js`                                     | The `#liveTv` screen container.                                                                                            |
| `js/ui/components/sidebarNavigationHelpers-01-root-sidebar-items.js` | The "Live TV" sidebar item.                                                                                                |
| `js/ui/screens/library/libraryScreenMethods-07-activate-node.js`     | Library lists the sidebar actions it handles; adds `gotoLiveTv`.                                                           |
| `js/ui/screens/settings/settingsScreenHelpers-03-*.js`               | The "Live TV" settings section and its icon.                                                                               |
| `js/ui/screens/settings/settingsScreenMethods-12-*.js`               | Renders the Live TV settings section.                                                                                      |
| `js/platform/adapters/tizenAdapter.js`                               | Registers the `ChannelUp` / `ChannelDown` keys.                                                                            |
| `js/core/update/appUpdateService.js`                                 | Checks this fork's releases, so Nuvio Live never offers official Nuvio's updates.                                          |
| `res/values/strings.xml`                                             | `nav_live_tv` and `livetv_*` strings (English only so far).                                                                |
| `package.json`, `package-lock.json`                                  | `test:livetv` script; `pako` as a direct dependency (it was already installed via jszip).                                  |
| `README.md`                                                          | A note about this fork.                                                                                                    |

## Known gaps

- English only (other languages fall back to English).
- No number-key entry, recordings, timeshift, VOD, DRM channels (out of scope).
- Catch-up asks the provider for a little before the programme; the player doesn't skip that lead-in yet
  (`planCatchup().leadMs` in `catchupUrl.js` has it).
- Not tried on webOS.

## Rebasing onto upstream

`main` tracks `upstream/main` (`NuvioMedia/NuvioTVSmart`); pushing to `upstream` is disabled in this clone.

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout live-tv && git rebase main
```
