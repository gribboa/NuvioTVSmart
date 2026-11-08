// Nuvio Live: the guide's pure logic (time grid, programme cells, group tabs, moving between
// programmes). No DOM here, so it is unit tested.
// Behaviour follows NuvioPlusIPTV (GPL-3.0), ui/LiveTvGuideScreen.kt and ui/GuideRowStrip.kt.

export const MINUTE_MS = 60 * 1000;
export const SLOT_MS = 30 * MINUTE_MS;
export const GUIDE_SPAN_MS = 150 * MINUTE_MS;

export const TAB = Object.freeze({ FAVOURITES: "__favourites", ALL: "__all", RECENT: "__recent" });

/** The half-hour mark at or before `ms` (in the TV's own time zone offsets of whole half-hours). */
export function floorToSlot(ms) {
  return Math.floor(ms / SLOT_MS) * SLOT_MS;
}

/** The time marks along the ruler: [{ ms, label }] every half hour from viewStart. */
export function rulerMarks(viewStartMs, spanMs = GUIDE_SPAN_MS, formatTime = defaultFormatTime) {
  const marks = [];
  for (let ms = floorToSlot(viewStartMs); ms < viewStartMs + spanMs; ms += SLOT_MS) {
    if (ms >= viewStartMs) marks.push({ ms, label: formatTime(ms) });
  }
  return marks;
}

export function defaultFormatTime(ms, use24Hour = true) {
  const date = new Date(ms);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (use24Hour) return `${String(hours).padStart(2, "0")}:${minutes}`;
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes}${hours < 12 ? "am" : "pm"}`;
}

/**
 * The cells of one guide row between viewStart and viewEnd: programmes clipped to the window,
 * with "no information" filler cells in the gaps. Each cell: { programme|null, startMs, stopMs,
 * left, width } where left/width are fractions (0..1) of the window.
 */
export function rowCells(programmes, viewStartMs, viewEndMs) {
  const span = viewEndMs - viewStartMs;
  const cells = [];
  let cursor = viewStartMs;
  const push = (programme, startMs, stopMs) => {
    if (stopMs <= startMs) return;
    cells.push({
      programme,
      startMs,
      stopMs,
      left: (startMs - viewStartMs) / span,
      width: (stopMs - startMs) / span
    });
  };
  programmes
    .filter((p) => p.stopMs > viewStartMs && p.startMs < viewEndMs)
    .sort((a, b) => a.startMs - b.startMs)
    .forEach((programme) => {
      const start = Math.max(programme.startMs, viewStartMs, cursor);
      const stop = Math.min(programme.stopMs, viewEndMs);
      if (start > cursor) push(null, cursor, start);
      if (stop > start) {
        push(programme, start, stop);
        cursor = stop;
      }
    });
  if (cursor < viewEndMs) push(null, cursor, viewEndMs);
  return cells;
}

/** The programme on at `ms`, or null. */
export function programmeAt(programmes, ms) {
  return programmes.find((p) => p.startMs <= ms && p.stopMs > ms) || null;
}

/**
 * Where focus goes when moving right/left from the programme at `focusMs`. Returns the new focus
 * time (the start of the next/previous programme, or a half-hour step through gaps), or null when
 * there's nothing further that way (before `minMs` / after `maxMs`).
 */
export function stepFocus(programmes, focusMs, direction, { minMs, maxMs }) {
  const sorted = programmes.slice().sort((a, b) => a.startMs - b.startMs);
  const current = programmeAt(sorted, focusMs);
  if (direction > 0) {
    const from = current ? current.stopMs : focusMs;
    const next = sorted.find((p) => p.startMs >= from);
    const target =
      next && next.startMs - from < SLOT_MS ? next.startMs : from + (current ? 0 : SLOT_MS);
    const ms = current && !next ? current.stopMs : target;
    return ms < maxMs ? ms : null;
  }
  const from = current ? current.startMs : focusMs;
  const previous = sorted.filter((p) => p.stopMs <= from).pop();
  let ms;
  if (previous && from - previous.stopMs < SLOT_MS) ms = previous.startMs;
  else ms = from - SLOT_MS;
  return ms >= minMs ? Math.max(ms, minMs) : null;
}

/** Moves the visible window so `focusMs` (and ideally the whole focused cell) is in view. */
export function viewForFocus(viewStartMs, focusMs, { spanMs = GUIDE_SPAN_MS, minMs, cell } = {}) {
  let start = viewStartMs;
  const end = () => start + spanMs;
  if (focusMs < start) start = floorToSlot(focusMs);
  // Keep at least an hour visible after the focused time.
  else if (focusMs >= end() - 2 * SLOT_MS) start = floorToSlot(focusMs) - SLOT_MS;
  if (cell && cell.startMs >= start && cell.startMs < end() && cell.stopMs > end()) {
    // Keep a programme that starts in view where it is; it just runs off the edge.
  }
  if (minMs != null && start < floorToSlot(minMs)) start = floorToSlot(minMs);
  return start;
}

/**
 * The guide's tabs: Favourites (when there are any), Recent (when any), All, then each group
 * that has channels and isn't hidden. [{ id, title, channelKeys }]
 */
export function buildTabs({
  channels,
  groups,
  favourites = [],
  recent = [],
  hiddenGroups = [],
  labels
}) {
  const known = new Set(channels.map((c) => c.key));
  const tabs = [];
  const favouriteKeys = favourites.filter((key) => known.has(key));
  if (favouriteKeys.length) {
    tabs.push({ id: TAB.FAVOURITES, title: labels.favourites, channelKeys: favouriteKeys });
  }
  const recentKeys = recent.filter((key) => known.has(key));
  if (recentKeys.length)
    tabs.push({ id: TAB.RECENT, title: labels.recent, channelKeys: recentKeys });
  const hidden = new Set(hiddenGroups);
  const visibleChannels = channels.filter((c) => !hidden.has(c.groupId));
  tabs.push({ id: TAB.ALL, title: labels.all, channelKeys: visibleChannels.map((c) => c.key) });
  const byGroup = new Map();
  channels.forEach((channel) => {
    const list = byGroup.get(channel.groupId) || [];
    list.push(channel.key);
    byGroup.set(channel.groupId, list);
  });
  groups.forEach((group) => {
    const keys = byGroup.get(group.id);
    if (keys?.length && !hidden.has(group.id)) {
      tabs.push({ id: group.id, title: group.title, channelKeys: keys });
    }
  });
  return tabs;
}

/** Keeps a row index inside the list, wrapping around (zapping) or clamping (guide). */
export function moveIndex(index, delta, length, { wrap = false } = {}) {
  if (!length) return 0;
  const next = index + delta;
  if (wrap) return ((next % length) + length) % length;
  return Math.max(0, Math.min(length - 1, next));
}

/** The first row to show so that `index` is visible with `visibleRows` rows. */
export function scrollTopFor(index, currentTop, visibleRows, length) {
  let top = currentTop;
  if (index < top) top = index;
  else if (index >= top + visibleRows) top = index - visibleRows + 1;
  return Math.max(0, Math.min(Math.max(0, length - visibleRows), top));
}

/** 0..1 through a programme at `nowMs`. */
export function progressOf(programme, nowMs) {
  if (!programme) return 0;
  const span = Math.max(1, programme.stopMs - programme.startMs);
  return Math.min(1, Math.max(0, (nowMs - programme.startMs) / span));
}
