# Nuvio Live: Live TV + IPTV for Nuvio on Samsung Tizen

Hand-off brief for a coding session. Read all of it before starting; work through the phases in order and stop at each **checkpoint** so the user can test on their TV.

## Goal

Add a Live TV section (IPTV playlists, a TiviMate-style guide, live playback, catch-up) to a fork of **`NuvioMedia/NuvioTVSmart`**, the JavaScript web app behind the official Nuvio Tizen/webOS builds. Use **`homelessbrian/NuvioPlusIPTV`**, an Android/Kotlin fork of Nuvio, as the _reference spec_ for behaviour and parsing logic. Both are GPL-3.0; keep the licence and credit NuvioPlusIPTV in the README and a file header on each ported module.

## Decisions already made (don't re-ask)

| Topic             | Decision                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target device     | 2025 Samsung The Frame 55" → **Tizen 9** (recent Chromium). Keep upstream's build target (`chrome56`) so other TVs still work; don't add new legacy workarounds just for old TVs.                                   |
| Remote            | The Frame ships with the **SolarCell remote**: D-pad, OK, Back, Home, a CH rocker and a volume rocker, **no number keys**. Design for that; number entry is not needed.                                             |
| Provider          | ~300 channels, available as **both M3U and Xtream**. Build both; Xtream first (it gives categories, guide and catch-up info directly).                                                                              |
| Adding a provider | **Phone via QR**: the TV shows a QR code, the phone opens a small page served _by the TV_ on the local network, and the details go straight to the TV. No outside server. On-screen keyboard entry is the fallback. |
| Guide layout      | **TiviMate-style**: live video preview + programme details at the top, time-grid guide below, group tabs.                                                                                                           |
| Catch-up          | **In the MVP.**                                                                                                                                                                                                     |
| Placement         | Its own **sidebar entry** ("Live TV") + a **"Favourite channels" row on Home** showing what's on now.                                                                                                               |
| Profiles          | **Sources shared** across profiles; **favourites and last-watched channel per profile**.                                                                                                                            |
| Repo              | **GitHub fork** of `NuvioMedia/NuvioTVSmart` under the user's account (`gribboa`). Work on a branch (e.g. `live-tv`), keep `main` tracking upstream.                                                                |
| Install           | **Alongside** official Nuvio: own app name ("Nuvio Live") and own Tizen IDs, e.g. package `NuvioLv001`, app `NuvioLv001.NuvioLive`. Tizen package IDs must be exactly 10 alphanumeric characters.                   |
| TV setup          | The user has already installed official Nuvio with the NuvioTVSmart-Installer, so Developer Mode → this PC already works.                                                                                           |
| Upstreaming       | Maybe later, not now. Still follow upstream's code style so it stays possible.                                                                                                                                      |
| Out of scope      | VPN, recordings, timeshift (pause/rewind live), Sports hub, Calendar, provider VOD (movies/series), DRM channels, number-key entry, sync with the Android app.                                                      |

## What NuvioTVSmart already provides (reuse, don't rebuild)

Checked against NuvioTVSmart v1.3.8:

- **Routes/screens:** `js/ui/navigation/router.js` imports and registers every screen. Add `LiveTvScreen` the same way.
- **D-pad focus:** `js/ui/navigation/focusEngine.js`, `dpadRepeatThrottle.js`.
- **Sidebar:** `ROOT_SIDEBAR_ITEMS` in `js/ui/components/sidebarNavigationHelpers-01-root-sidebar-items.js`.
- **Live playback:** `PlayerScreen` (opened with `Router.navigate("player", {...})`) already treats `itemType: "CHANNEL"` as live (`js/ui/screens/player/livePlaybackUi.js`, tested by `scripts/test-live-player-controls.mjs`). Samsung AVPlay is wired up in `js/core/player/playerControllerMethods-09-play-with-av-play.js`, with hls.js/dash.js as alternatives.
- **Network:** the generated `config.xml` has `<access origin="*" subdomains="true"/>`, so provider and EPG requests need no CORS workarounds on the TV.
- **Storage:** `js/core/storage/localStore.js` (small settings) and IndexedDB (already used by `js/data/local/pluginCodeStore.js`, with the `unlimitedstorage` privilege declared). Use IndexedDB for channels and guide data.
- **Profiles:** `ProfileManager.getActiveProfileId()` in `js/core/profile/profileManager.js`; key per-profile data by it.
- **Home rows:** see `js/ui/screens/home/homeRowMerge.js` and the continue-watching row code for how rows are built and merged.
- **QR codes:** `js/core/qr/qrCodeGenerator.js`.
- **Tizen background services:** `services/tizen/plugin-service.js` runs a Node-style HTTP server (`localServer.listen(2711)`, called with one argument, so it likely binds all interfaces) as a `tizen:service`. This is the starting point for the phone-setup server.
- **Packaging:** `npm run package:tizen` builds an unsigned `.wgt`; `scripts/package-tizen.mjs` accepts `--appId` / `--packageId`. ID constants are at the top of that file.
- **Tests:** Node `node --test` files under `scripts/` and `tests/`. Add parser/catch-up tests the same way.

## Reference code to port (NuvioPlusIPTV)

Under `app/src/main/java/com/nuvio/tv/livetv/`. Port **logic and behaviour**, not the Compose/ExoPlayer code.

| Kotlin file                                                                        | Port to                                | Notes                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data/M3uParser.kt` (235 lines)                                                    | `js/livetv/data/m3uParser.js`          | `#EXTINF` attributes, `tvg-id`/`tvg-name`/`tvg-logo`/`group-title`, `url-tvg`/`x-tvg-url` header, `catchup`/`catchup-days`/`catchup-source`. Skip KODIPROP DRM.                                                                                                                                                    |
| `data/LiveTvRepository.kt` (Xtream parts, search `addXtream`, `isXtream`)          | `js/livetv/data/xtreamClient.js`       | `player_api.php` (`get_live_categories`, `get_live_streams`, user info incl. server timezone), `xmltv.php` for the guide, stream URL forms (`.ts`/`.m3u8`), credentials from a pasted `get.php?username=…&password=…` link (`PlaylistSource.credentialsFromLink`, `cleanXtreamServer` in `model/LiveTvModels.kt`). |
| `data/XmltvParser.kt` (352)                                                        | `js/livetv/data/xmltvParser.js`        | Keep the time-window filter, `parseTime`, episode-number formatting. Must be streaming (see Phase 2).                                                                                                                                                                                                              |
| `data/EpgDatabase.kt` (720)                                                        | `js/livetv/data/epgStore.js`           | IndexedDB: programmes indexed by `[channelKey, start]`; prune past the window.                                                                                                                                                                                                                                     |
| `data/LiveTvChannelStore.kt` (207)                                                 | `js/livetv/data/channelStore.js`       | Channels + groups per source.                                                                                                                                                                                                                                                                                      |
| `data/CatchupUrlBuilder.kt` (259)                                                  | `js/livetv/data/catchupUrl.js`         | Pure functions: shift/append, flussonic, xtream (`timeshift` URLs with server timezone), template fill, alternatives/fallbacks. Port the tests' cases as `node --test`.                                                                                                                                            |
| `model/LiveTvModels.kt` (855)                                                      | `js/livetv/model.js`                   | Only `PlaylistSource`, `EpgSource`, `CatchupInfo`, `LiveChannel`, `EpgProgram`, `ChannelGroup`, and a slim settings object.                                                                                                                                                                                        |
| `ui/LiveTvGuideScreen.kt` (4,828), `ui/GuideRowStrip.kt`, `ui/LiveTvComponents.kt` | `js/ui/screens/livetv/*`               | Guide behaviour: layout, focus rules, time ruler, now-line, group tabs, preview.                                                                                                                                                                                                                                   |
| `ui/LiveTvViewModel.kt` (1,654)                                                    | `js/livetv/liveTvController.js`        | Load/refresh state, selected group, now/next lookup, zapping order.                                                                                                                                                                                                                                                |
| `ui/LiveTvPlayerPanel.kt`, `ui/LiveTvOverlayMode.kt`                               | `js/ui/screens/livetv/liveOverlay*.js` | Channel banner and quick channel list over full-screen video.                                                                                                                                                                                                                                                      |
| `player/LiveTvPlaybackController.kt` (2,135)                                       | small hooks only                       | Take its retry/fallback rules (e.g. Xtream `.ts` ↔ `.m3u8`), not its code.                                                                                                                                                                                                                                         |

Expected size: roughly 4–6k lines of new JS.

## Code organisation rules

- New code lives only in **`js/livetv/`** (data, logic) and **`js/ui/screens/livetv/`** (UI), plus `css/livetv*.css` and new i18n keys.
- Touch existing files only where you have to: router registration, sidebar item, Home favourites row, player hooks (CH keys, overlay), settings entry, `package-tizen.mjs` IDs/name, `services/tizen/` for the setup server. List every touched upstream file in `docs/LIVE_TV.md` so rebasing stays easy.
- Follow upstream conventions: ES modules, `*Methods-NN-*.js` splitting for large classes, `I18n` for user-facing strings, existing lint/prettier config.

---

## Phases

### Phase 0: Fork, rename, build, install (½–1 day)

1. Fork `NuvioMedia/NuvioTVSmart` to `gribboa` (`gh repo fork`) and clone it locally (ask the user where; suggest `C:\Users\Alex\GIT\nuvio-live`). Create branch `live-tv`. Copy this plan to `docs/LIVE_TV_PLAN.md`.
2. `npm install`, `npm run build`, `npm test` to confirm a clean baseline. Note any upstream failures; don't fix them.
3. Change the Tizen package/app IDs and display name for the side-by-side install. Check whether `scripts/package-tizen.mjs` validation or the boot guard hard-code `NuvioTV001` anywhere.
4. Install on the TV. The NuvioTVSmart-Installer has a local-file picker (`installer:selectFile` in `src/main.js`). Check whether it installs a local `.wgt` and accepts a different package ID; its `installer.config.json` lists allowed `tizen.appIds`. If it doesn't, fork the installer too and change `installer.config.json` (`githubRepo` → the fork; new `appId`/`packageId`/`appIds`). Keep the WGT layout the installer validates (EngineFS on 2710, PluginService on 2711, `services/plugin-http.cjs`, inline `wrt:service` bridge).

**Checkpoint 0:** "Nuvio Live" launches on the Frame next to official Nuvio and works like normal Nuvio.

### Phase 1: Phone setup spike (1 day, do this early: it's the biggest unknown)

Prove the TV can serve a page to a phone on the LAN before building on it.

1. In a Tizen service (extend `plugin-service.js` or add a `livetv-setup` service; prefer _extending_, because the installer checks the exact service set), start an HTTP listener on a new port (e.g. 2712) **only while the setup screen is open**.
2. The web app gets the TV's LAN IP (`tizen.systeminfo` `WIFI_NETWORK`/`ETHERNET_NETWORK`, `ipAddress`) and shows a QR code for `http://<tv-ip>:2712/setup?t=<one-time token>`.
3. The phone page (a plain HTML form served by the service) has tabs for **Xtream** (server, username, password) and **M3U** (playlist URL, optional EPG URL). On submit it POSTs to the service with the token; the app picks it up (poll the service on `127.0.0.1`, as the app already does for 2711).
4. Security: random token per session, reject requests without it, close the listener on submit/leave/timeout (≈10 min), never log passwords.
5. **If inbound LAN connections are blocked on Tizen 9**, tell the user, and fall back to on-screen keyboard entry plus "paste one Xtream link" (`get.php?username=…`) as the single field.

**Checkpoint 1:** the user scans the QR code, submits test details from their phone, and the TV shows them.

### Phase 2: Sources, channels, basic playback (2–3 days)

1. `model.js`, `xtreamClient.js`, `m3uParser.js`, `channelStore.js` with `node --test` coverage (fixtures from the Kotlin parser's behaviour).
2. Settings → **Live TV**: list sources, add (via Phase 1), refresh, remove; per-source optional User-Agent/headers.
3. Load sources at startup and on manual refresh; cache channels in IndexedDB and show the cache instantly, then refresh in the background.
4. A temporary simple channel list screen; OK opens `PlayerScreen` with `itemType: "CHANNEL"`, title and logo.
5. Xtream stream URL: prefer `.ts` via AVPlay; fall back to `.m3u8` on error (and the reverse).

**Checkpoint 2:** all ~300 channels from the user's Xtream account list by group and play.

### Phase 3: Guide data (2–3 days)

1. Guide sources: Xtream `xmltv.php`, M3U `url-tvg`/`x-tvg-url`, or a manually added XMLTV URL. Handle `.gz` (`fflate` streaming gunzip; don't rely on `DecompressionStream`).
2. Streaming parse: `fetch` → `response.body` reader → incremental gunzip → SAX-style XMLTV parser in a **Web Worker**. Keep programmes in a window (default −catch-up days … +3 days) and write to IndexedDB in batches.
3. Match channels by `tvg-id` → XMLTV channel id, then by normalised name.
4. Refresh on launch if older than N hours (setting; default 12) and on demand; show "Guide updated …".

**Checkpoint 3:** now/next is correct for most of the 300 channels, and the user's TV timezone is right (test a channel against the provider's own app).

### Phase 4: TiviMate-style guide screen (4–6 days)

Layout, top to bottom:

- **Top ~40%:** left is the live preview of the focused/last channel (small AVPlay display rect; check that resizing via `playerControllerMethods-08-set-av-play-display-rect.js` works while browsing); right is the focused programme's title, time, episode, description, channel logo/name.
- **Group tabs:** Favourites, All, then provider groups (hideable later).
- **Grid:** channel column (logo, name) + time ruler + programme cells, with a now-line. Virtualise: render only the visible rows (~8–10) and ~2.5 hours, and recycle nodes. 300 channels on Tizen 9 is light, but keep it virtualised anyway.

Remote behaviour (SolarCell remote):

- **Up/Down:** move through channels; **Left/Right:** through programmes in time, and Left at "now" goes to the channel column.
- **OK on a current programme:** play full screen. **OK on a past programme** with catch-up: play catch-up (Phase 6). **OK on a future programme:** show details.
- **Long-press OK:** toggle favourite.
- **CH rocker:** page up/down through channels.
- **Back:** to the channel column, then to the sidebar.
- Preview changes channel only after focus rests ~600 ms, so browsing doesn't hammer the provider.

Wire the **sidebar "Live TV" item** to this screen and remove the temporary list from Phase 2.

**Checkpoint 4:** the user browses the guide on the TV and confirms it feels smooth and matches what they expect from TiviMate.

### Phase 5: Watching live (2–3 days)

1. **CH up/down** during full-screen playback zaps within the current group (wrap around). Register keys with `tizen.tvinputdevice.registerKey` (`ChannelUp`, `ChannelDown`; the privilege is already declared). Up/Down on the D-pad does the same when no overlay is open.
2. **Info banner** on zap/OK: channel logo/name, now/next, progress bar; it auto-hides.
3. **Quick channel list** (Left, or OK when the banner is hidden): an overlay list of the group with now-playing, without stopping the video.
4. **Back** from full screen returns to the guide focused on that channel.
5. Remember the **last channel per profile**; a "last channel" toggle on a key that's free on the SolarCell remote, if there is one.
6. Dead stream: retry once, try the alternate URL form, then show a clear error with "Try again".

**Checkpoint 5:** zapping with the CH rocker is quick and the overlays work.

### Phase 6: Catch-up (1–2 days)

1. Port `CatchupUrlBuilder` with tests (Xtream timeshift with the server timezone from `player_api.php`, flussonic, shift/append, `catchup-source` templates).
2. In the guide, mark past programmes that can be played (channel has catch-up and the programme is within `catchup-days`).
3. Play as seekable (non-live) through `PlayerScreen`, with title = programme name.

**Checkpoint 6:** the user plays something from yesterday on a catch-up channel and can seek.

### Phase 7: Home row, favourites, polish (2 days)

1. Per-profile favourites (IndexedDB keyed by `ProfileManager.getActiveProfileId()`); Favourites tab in the guide.
2. **Home "Favourite channels" row:** cards with logo, channel name, what's on now + progress; OK plays. Hidden when there are no favourites. Respect upstream's home row settings/order if there is a mechanism for it.
3. Settings: guide days ahead, refresh interval, hide groups, per-source User-Agent.
4. `docs/LIVE_TV.md`: features, how to add a provider, the touched upstream files, how to rebase onto upstream.

**Checkpoint 7 (MVP done):** the user's daily use (Home row → favourite channel, guide browsing, zapping, catch-up) works on the Frame.

---

## Testing approach

- **Unit tests** (`node --test`) for M3U parsing, Xtream response mapping, XMLTV parsing/time handling, channel↔guide matching and catch-up URLs. Never commit the user's real provider details or URLs; use made-up fixtures.
- **Desktop browser** (`npm run serve`) for layout and focus work; playback differs there, so confirm playback on the TV.
- **The TV** at every checkpoint: build the `.wgt`, install with the installer, and ask the user to test. You can't see the TV, so give them a short checklist each time.
- Run upstream's `npm test` and `npm run lint` before each checkpoint; don't break existing tests.

## Risks to watch

1. **Phone setup may be blocked** (Phase 1). Fall back as described; don't sink days into it.
2. **Preview + full-screen AVPlay switching:** one AVPlay instance; check the display-rect resize and that leaving the guide doesn't leave a stuck video layer.
3. **Provider quirks:** User-Agent blocking, `.ts` vs `.m3u8`, timezone offsets in the guide or catch-up. Expose per-source settings rather than hard-coding.
4. **Upstream drift:** NuvioTVSmart changes daily. Keep touchpoints small; rebase `live-tv` on upstream `main` at least once mid-project.
5. **Installer validation:** any change to `services/` or `config.xml` must still pass the installer's WGT checks.

## Communication

- Ask the user only for things they must decide or do: TV tests, where to clone, provider details (they enter these on the TV, never in chat or code).
- Never push to `NuvioMedia/*`. Push only to the user's fork.
