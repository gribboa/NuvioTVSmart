import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MATCH,
  buildChannelMatchIndex,
  idName,
  matchGuideChannel,
  normalizeChannelName,
  offerGuideMatch
} from "./guideMatching.js";

test("normalizeChannelName drops prefixes, brackets, quality and punctuation", () => {
  assert.equal(normalizeChannelName("UK: BBC One HD"), "bbcone");
  assert.equal(normalizeChannelName("bbc one (backup)"), "bbcone");
  assert.equal(normalizeChannelName("Sky Sports [FHD] Main-Event"), "skysportsmainevent");
  assert.equal(normalizeChannelName("Das Erste"), "daserste");
  assert.equal(normalizeChannelName("ТНТ"), "тнт");
  assert.equal(normalizeChannelName(""), "");
});

test("idName reads a guide id as a name", () => {
  assert.equal(idName("GloboSP.br"), "globosp");
  assert.equal(idName("bbcone.co.uk"), "bbcone");
  assert.equal(idName("ITV1.uk"), "itv1");
});

const channels = [
  { key: "s:1", name: "UK: BBC One HD", tvgId: "BBCOne.uk", tvgName: "" },
  { key: "s:2", name: "ITV 1", tvgId: "", tvgName: "ITV1" },
  { key: "s:3", name: "Film4", tvgId: "film4.uk", tvgName: "" },
  { key: "s:4", name: "BBC One (backup)", tvgId: "", tvgName: "" }
];

test("matchGuideChannel prefers tvg-id and falls back to names", () => {
  const index = buildChannelMatchIndex(channels);
  assert.deepEqual(matchGuideChannel(index, "bbcone.uk", ["BBC One"]), [
    { channelKey: "s:1", quality: MATCH.ID },
    { channelKey: "s:4", quality: MATCH.NAME }
  ]);
  assert.deepEqual(matchGuideChannel(index, "itv1.uk", ["ITV1 HD"]), [
    { channelKey: "s:2", quality: MATCH.NAME }
  ]);
  assert.deepEqual(matchGuideChannel(index, "FILM4.UK", []), [
    { channelKey: "s:3", quality: MATCH.ID }
  ]);
  assert.deepEqual(matchGuideChannel(index, "unknown.id", ["Nothing Here"]), []);
});

test("offerGuideMatch keeps the better match, then the earlier guide", () => {
  const best = new Map();
  offerGuideMatch(best, "s:1", "g2|bbc", MATCH.NAME, 1);
  offerGuideMatch(best, "s:1", "g1|bbc", MATCH.NAME, 0);
  assert.equal(best.get("s:1").guideId, "g1|bbc");
  offerGuideMatch(best, "s:1", "g3|bbc", MATCH.ID, 2);
  assert.equal(best.get("s:1").guideId, "g3|bbc");
  offerGuideMatch(best, "s:1", "g1|other", MATCH.NAME, 0);
  assert.equal(best.get("s:1").guideId, "g3|bbc");
});
