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

## Upstream files touched

Keep this list complete so rebasing onto upstream stays easy.

| File                        | Why                                                                         |
| --------------------------- | --------------------------------------------------------------------------- |
| `scripts/package-tizen.mjs` | App name, Tizen package/app ids and widget id for the side-by-side install. |

## Rebasing onto upstream

`main` tracks `upstream/main` (`NuvioMedia/NuvioTVSmart`); pushing to `upstream` is disabled in this clone.

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout live-tv && git rebase main
```
