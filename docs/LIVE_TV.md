# Nuvio Live

A fork of [NuvioMedia/NuvioTVSmart](https://github.com/NuvioMedia/NuvioTVSmart) that adds a Live TV / IPTV
section (Xtream and M3U sources, a TiviMate-style guide, live playback, catch-up). Behaviour and parsing
logic are ported from [homelessbrian/NuvioPlusIPTV](https://github.com/homelessbrian/NuvioPlusIPTV)
(Android/Kotlin). Both projects are GPL-3.0, and so is this fork.

The plan and phase checkpoints are in [LIVE_TV_PLAN.md](LIVE_TV_PLAN.md).

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

Sources are shared by every profile and kept on the TV only (`localStorage` key `liveTvSources`).

## Development

- `npm run test:livetv` runs the Live TV tests (model/parsing, setup server).
- Desktop: `npm run serve` has no TV plugin service. To try the phone setup in a browser, start
  `services/plugin-http.cjs` on 127.0.0.1:2711 with Node and set `window.__NUVIO_LIVETV_SETUP_PORT__ = 2711`
  in the console before opening Live TV.

## Upstream files touched

Keep this list complete so rebasing onto upstream stays easy. New code lives in `js/livetv/`,
`js/ui/screens/livetv/`, `css/livetv.css`, `services/livetv-setup.cjs` and `scripts/test-livetv-*.mjs`.

| File                                                                 | Why                                                                                    |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `scripts/package-tizen.mjs`                                          | App name, Tizen ids and widget id; packages and requires `services/livetv-setup.cjs`.  |
| `services/plugin-http.cjs`                                           | `POST /livetv-setup` loopback route that starts, reads and stops the phone setup page. |
| `js/ui/navigation/router.js`                                         | Registers the `liveTv` route.                                                          |
| `js/bootstrap/renderAppShell.js`                                     | The `#liveTv` screen container.                                                        |
| `js/ui/components/sidebarNavigationHelpers-01-root-sidebar-items.js` | The "Live TV" sidebar item.                                                            |
| `js/ui/screens/library/libraryScreenMethods-07-activate-node.js`     | Library lists the sidebar actions it handles; adds `gotoLiveTv`.                       |
| `js/core/update/appUpdateService.js`                                 | Checks this fork's releases, so Nuvio Live never offers official Nuvio's updates.      |
| `res/values/strings.xml`                                             | `nav_live_tv` and `livetv_*` strings (English only so far).                            |
| `package.json`                                                       | `test:livetv` script.                                                                  |

## Rebasing onto upstream

`main` tracks `upstream/main` (`NuvioMedia/NuvioTVSmart`); pushing to `upstream` is disabled in this clone.

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout live-tv && git rebase main
```
