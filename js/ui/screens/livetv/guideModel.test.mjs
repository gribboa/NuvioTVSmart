import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GUIDE_SPAN_MS,
  MINUTE_MS,
  SLOT_MS,
  TAB,
  buildTabs,
  floorToSlot,
  moveIndex,
  programmeAt,
  progressOf,
  rowCells,
  rulerMarks,
  scrollTopFor,
  stepFocus,
  viewForFocus
} from "./guideModel.js";

const T0 = Date.UTC(2026, 10, 8, 18, 0, 0);
const at = (minutes) => T0 + minutes * MINUTE_MS;
const p = (from, to, title) => ({ startMs: at(from), stopMs: at(to), title });

test("floorToSlot and rulerMarks use half-hour marks", () => {
  assert.equal(floorToSlot(at(44)), at(30));
  const marks = rulerMarks(at(0), GUIDE_SPAN_MS, (ms) => String((ms - T0) / MINUTE_MS));
  assert.deepEqual(
    marks.map((m) => m.label),
    ["0", "30", "60", "90", "120"]
  );
});

test("rowCells clips programmes to the window and fills gaps", () => {
  const programmes = [p(-30, 20, "A"), p(40, 100, "B"), p(100, 200, "C")];
  const cells = rowCells(programmes, at(0), at(150));
  assert.deepEqual(
    cells.map((c) => [
      c.programme?.title || null,
      (c.startMs - T0) / MINUTE_MS,
      (c.stopMs - T0) / MINUTE_MS
    ]),
    [
      ["A", 0, 20],
      [null, 20, 40],
      ["B", 40, 100],
      ["C", 100, 150]
    ]
  );
  assert.ok(Math.abs(cells.reduce((sum, c) => sum + c.width, 0) - 1) < 1e-9);
  assert.deepEqual(
    rowCells([], at(0), at(150)).map((c) => c.programme),
    [null]
  );
});

test("rowCells ignores overlapping programmes instead of drawing them twice", () => {
  const cells = rowCells([p(0, 60, "A"), p(30, 90, "B")], at(0), at(150));
  assert.deepEqual(
    cells.map((c) => [c.programme?.title || null, (c.startMs - T0) / MINUTE_MS]),
    [
      ["A", 0],
      ["B", 60],
      [null, 90]
    ]
  );
});

test("stepFocus moves between programmes and through gaps", () => {
  const programmes = [p(0, 30, "A"), p(30, 90, "B"), p(150, 180, "C")];
  const bounds = { minMs: at(-60), maxMs: at(600) };
  assert.equal(stepFocus(programmes, at(10), 1, bounds), at(30));
  assert.equal(stepFocus(programmes, at(40), 1, bounds), at(90), "into the gap after B");
  assert.equal(stepFocus(programmes, at(90), 1, bounds), at(120), "half an hour through the gap");
  assert.equal(stepFocus(programmes, at(120), 1, bounds), at(150), "reaches C");
  assert.equal(stepFocus(programmes, at(40), -1, bounds), at(0));
  assert.equal(stepFocus(programmes, at(10), -1, bounds), at(-30));
  assert.equal(stepFocus(programmes, at(10), -1, { minMs: at(0), maxMs: at(600) }), null);
  assert.equal(stepFocus(programmes, at(160), 1, { minMs: at(0), maxMs: at(180) }), null);
});

test("viewForFocus scrolls by half hours to keep focus visible", () => {
  assert.equal(viewForFocus(at(0), at(60)), at(0));
  assert.equal(viewForFocus(at(0), at(140)), at(90));
  assert.equal(viewForFocus(at(60), at(10)), at(0));
  assert.equal(viewForFocus(at(60), at(-200), { minMs: at(-90) }), at(-90));
});

test("programmeAt and progressOf", () => {
  const programmes = [p(0, 30, "A"), p(30, 90, "B")];
  assert.equal(programmeAt(programmes, at(45)).title, "B");
  assert.equal(programmeAt(programmes, at(95)), null);
  assert.equal(progressOf(p(0, 60, "A"), at(15)), 0.25);
  assert.equal(progressOf(null, at(15)), 0);
});

test("buildTabs: favourites, recent, all, then non-empty visible groups", () => {
  const channels = [
    { key: "a", groupId: "g1" },
    { key: "b", groupId: "g2" },
    { key: "c", groupId: "g2" }
  ];
  const groups = [
    { id: "g1", title: "News" },
    { id: "g2", title: "Sport" },
    { id: "g3", title: "Empty" }
  ];
  const labels = { favourites: "Favourites", recent: "Recent", all: "All" };
  const tabs = buildTabs({ channels, groups, favourites: ["c", "gone"], recent: [], labels });
  assert.deepEqual(
    tabs.map((t) => [t.id, t.channelKeys]),
    [
      [TAB.FAVOURITES, ["c"]],
      [TAB.ALL, ["a", "b", "c"]],
      ["g1", ["a"]],
      ["g2", ["b", "c"]]
    ]
  );
  const hidden = buildTabs({ channels, groups, hiddenGroups: ["g2"], labels });
  assert.deepEqual(
    hidden.map((t) => [t.id, t.channelKeys]),
    [
      [TAB.ALL, ["a"]],
      ["g1", ["a"]]
    ]
  );
});

test("moveIndex wraps for zapping and clamps for the guide; scrollTopFor keeps rows visible", () => {
  assert.equal(moveIndex(0, -1, 5, { wrap: true }), 4);
  assert.equal(moveIndex(4, 1, 5, { wrap: true }), 0);
  assert.equal(moveIndex(0, -1, 5), 0);
  assert.equal(moveIndex(3, 8, 5), 4);
  assert.equal(scrollTopFor(9, 0, 8, 300), 2);
  assert.equal(scrollTopFor(1, 5, 8, 300), 1);
  assert.equal(scrollTopFor(299, 0, 8, 300), 292);
  assert.equal(scrollTopFor(3, 0, 8, 4), 0);
  assert.equal(SLOT_MS, 30 * MINUTE_MS);
});
