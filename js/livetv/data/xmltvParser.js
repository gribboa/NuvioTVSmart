// Nuvio Live: streaming XMLTV guide parser (text chunks in, channels and programmes out).
// Ported from NuvioPlusIPTV (GPL-3.0), app/src/main/java/com/nuvio/tv/livetv/data/XmltvParser.kt.
//
// Provider guides are often 20-200 MB, so nothing like a DOM is built: the text is scanned with
// indexOf as it arrives, each <channel> / <programme> is handed over as soon as it is complete,
// and only the unread tail of the text is kept. Like the Android app it is forgiving: a stray
// "&", an HTML entity such as &nbsp; or a <programme> that is never closed does not stop the
// rest of the guide from being read.

const ELLIPSIS = String.fromCharCode(0x2026);
const NO_INFORMATION = "No information";
const MAX_DESCRIPTION = 800;
const MAX_PEOPLE = 12;
const MAX_INTERNED_LENGTH = 80;
const MAX_INTERNED = 20000;
// After a push that ended mid-element, wait for this much more text before scanning again, so
// many tiny chunks do not rescan the same unfinished element over and over.
const RESCAN_GROWTH = 2048;

const CDATA_OPEN = "<![CDATA[";
const COMMENT_OPEN = "<!--";
// A <programme> (or <channel>) starting inside another one: that one was never closed.
const TOP_LEVEL_NAMES = ["channel", "programme"];

function chars(...codes) {
  return String.fromCharCode(...codes);
}

// XML's own entities plus the HTML ones guides use most (relaxed parsing, like Android's).
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: chars(0xa0),
  ndash: chars(0x2013),
  mdash: chars(0x2014),
  hellip: ELLIPSIS,
  lsquo: chars(0x2018),
  rsquo: chars(0x2019),
  ldquo: chars(0x201c),
  rdquo: chars(0x201d),
  laquo: chars(0xab),
  raquo: chars(0xbb),
  copy: chars(0xa9),
  reg: chars(0xae),
  trade: chars(0x2122),
  deg: chars(0xb0),
  euro: chars(0x20ac),
  pound: chars(0xa3)
};

function isDigitCode(c) {
  return c >= 48 && c <= 57;
}

function isNameStartCode(c) {
  // A-Z, a-z, "_", ":" or any non-ASCII character.
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c >= 128;
}

/** Decodes XML entities (named, &#123; and &#x1F;). Unknown or broken ones are left as written. */
export function decodeXmlEntities(text) {
  let amp = text.indexOf("&");
  if (amp < 0) return text;
  let out = "";
  let from = 0;
  while (amp >= 0) {
    const semi = text.indexOf(";", amp + 1);
    if (semi < 0) break;
    if (semi - amp > 12) {
      amp = text.indexOf("&", amp + 1);
      continue;
    }
    const name = text.slice(amp + 1, semi);
    let decoded = null;
    if (name.charCodeAt(0) === 35) {
      const hex = name.charCodeAt(1) === 120 || name.charCodeAt(1) === 88;
      const digits = name.slice(hex ? 2 : 1);
      const code = digits && /^[0-9a-fA-F]+$/.test(digits) ? parseInt(digits, hex ? 16 : 10) : NaN;
      if ((hex || /^[0-9]+$/.test(digits)) && code > 0 && code <= 0x10ffff) {
        decoded = String.fromCodePoint(code);
      }
    } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)) {
      decoded = NAMED_ENTITIES[name];
    }
    if (decoded === null) {
      amp = text.indexOf("&", amp + 1);
      continue;
    }
    out += text.slice(from, amp) + decoded;
    from = semi + 1;
    amp = text.indexOf("&", from);
  }
  return from === 0 ? text : out + text.slice(from);
}

/**
 * Index of the ">" that ends the tag starting at [lt], skipping quoted attribute values, or -1
 * when the text ends first. Only the tag itself is walked character by character.
 */
function findTagEnd(s, lt) {
  let p = lt + 1;
  for (;;) {
    const gt = s.indexOf(">", p);
    if (gt < 0) return -1;
    let quote = -1;
    for (let k = p; k < gt; k++) {
      const c = s.charCodeAt(k);
      if (c === 34 || c === 39) {
        quote = k;
        break;
      }
    }
    if (quote < 0) return gt;
    const close = s.indexOf(s[quote], quote + 1);
    if (close < 0) return -1;
    p = close + 1;
  }
}

/** The element name of the tag at [lt] ("<name ...>" or "</name>"). */
function tagName(s, lt) {
  let p = lt + 1;
  if (s.charCodeAt(p) === 47) p++;
  const start = p;
  for (;;) {
    const c = s.charCodeAt(p);
    // End of text (NaN), whitespace, ">" or "/".
    if (!(c > 32) || c === 62 || c === 47) break;
    p++;
  }
  return s.slice(start, p);
}

/** True if the tag name at [at] is exactly [name] (no string is made). */
function nameIs(s, at, name) {
  if (!s.startsWith(name, at)) return false;
  const c = s.charCodeAt(at + name.length);
  return !(c > 32) || c === 62 || c === 47;
}

/**
 * Skips "<!-- -->", "<![CDATA[ ]]>" or "<!DOCTYPE ...>" starting at [lt]: the index after it,
 * or -1 when it is not complete yet.
 */
function skipMarkup(s, lt) {
  if (s.startsWith(COMMENT_OPEN, lt)) {
    const end = s.indexOf("-->", lt + 4);
    return end < 0 ? -1 : end + 3;
  }
  if (s.startsWith(CDATA_OPEN, lt)) {
    const end = s.indexOf("]]>", lt + 9);
    return end < 0 ? -1 : end + 3;
  }
  const rest = s.length - lt;
  if (rest < 9 && (CDATA_OPEN.startsWith(s.slice(lt)) || COMMENT_OPEN.startsWith(s.slice(lt)))) {
    return -1;
  }
  const gt = s.indexOf(">", lt);
  return gt < 0 ? -1 : gt + 1;
}

/**
 * Finds where the element whose content starts at [from] ends. Returns { innerEnd, after }, or
 * null when the text ends first. Its own closing tag ends it at any depth (an unclosed child
 * does not swallow the rest), and with [stopNames] a nested start tag of one of those names
 * ends it just before that tag.
 */
function findClose(s, from, name, stopNames) {
  let depth = 0;
  let p = from;
  for (;;) {
    const lt = s.indexOf("<", p);
    if (lt < 0 || lt + 1 >= s.length) return null;
    const c = s.charCodeAt(lt + 1);
    if (c === 33) {
      const next = skipMarkup(s, lt);
      if (next < 0) return null;
      p = next;
      continue;
    }
    if (c === 63) {
      const end = s.indexOf("?>", lt + 2);
      if (end < 0) return null;
      p = end + 2;
      continue;
    }
    if (c !== 47 && !isNameStartCode(c)) {
      p = lt + 1; // a bare "<" in the text
      continue;
    }
    const gt = findTagEnd(s, lt);
    if (gt < 0) return null;
    if (c === 47) {
      if (depth === 0 || nameIs(s, lt + 2, name)) return { innerEnd: lt, after: gt + 1 };
      depth--;
    } else if (stopNames !== null && stopNames.some((stop) => nameIs(s, lt + 1, stop))) {
      return { innerEnd: lt, after: lt };
    } else if (s.charCodeAt(gt - 1) !== 47) {
      depth++;
    }
    p = gt + 1;
  }
}

/** Calls visit(name, tag, inner) for every element directly inside [body]. */
function forEachChild(body, visit) {
  let p = 0;
  for (;;) {
    const lt = body.indexOf("<", p);
    if (lt < 0 || lt + 1 >= body.length) return;
    const c = body.charCodeAt(lt + 1);
    if (c === 33 || c === 63 || c === 47) {
      const next = c === 33 ? skipMarkup(body, lt) : findTagEnd(body, lt) + 1;
      if (next <= 0) return;
      p = next;
      continue;
    }
    if (!isNameStartCode(c)) {
      p = lt + 1;
      continue;
    }
    const gt = findTagEnd(body, lt);
    if (gt < 0) return;
    const name = tagName(body, lt);
    const tag = body.slice(lt, gt + 1);
    if (body.charCodeAt(gt - 1) === 47) {
      visit(name, tag, "");
      p = gt + 1;
      continue;
    }
    const close = findClose(body, gt + 1, name, null);
    if (close === null) {
      // Never closed: it runs to the end of its parent.
      visit(name, tag, body.slice(gt + 1));
      return;
    }
    visit(name, tag, body.slice(gt + 1, close.innerEnd));
    p = close.after;
  }
}

/** The text inside an element: entities decoded, CDATA kept as written, nested tags dropped. */
function textContent(raw) {
  if (raw.indexOf("<") < 0) return decodeXmlEntities(raw);
  let out = "";
  let p = 0;
  while (p < raw.length) {
    const lt = raw.indexOf("<", p);
    if (lt < 0) {
      out += decodeXmlEntities(raw.slice(p));
      break;
    }
    if (lt > p) out += decodeXmlEntities(raw.slice(p, lt));
    if (raw.startsWith(CDATA_OPEN, lt)) {
      const end = raw.indexOf("]]>", lt + 9);
      if (end < 0) {
        out += raw.slice(lt + 9);
        break;
      }
      out += raw.slice(lt + 9, end);
      p = end + 3;
      continue;
    }
    const c = raw.charCodeAt(lt + 1);
    if (c !== 33 && c !== 47 && c !== 63 && !isNameStartCode(c)) {
      out += "<";
      p = lt + 1;
      continue;
    }
    const next = c === 33 ? skipMarkup(raw, lt) : findTagEnd(raw, lt) + 1;
    if (next <= 0) break;
    p = next;
  }
  return out;
}

/** Attributes of a start tag ("<name a="1" b='2'>"), entities decoded. */
function parseAttributes(tag) {
  const out = {};
  const n = tag.length;
  let p = 1;
  while (p < n && tag.charCodeAt(p) > 32 && tag.charCodeAt(p) !== 62 && tag.charCodeAt(p) !== 47) {
    p++;
  }
  for (;;) {
    while (p < n && (tag.charCodeAt(p) <= 32 || tag.charCodeAt(p) === 47)) p++;
    if (p >= n || tag.charCodeAt(p) === 62) break;
    const eq = tag.indexOf("=", p);
    if (eq < 0) break;
    // The name is the last word before "=" (a value-less attribute before it is ignored).
    let nameEnd = eq;
    while (nameEnd > p && tag.charCodeAt(nameEnd - 1) <= 32) nameEnd--;
    let nameStart = nameEnd;
    while (nameStart > p && tag.charCodeAt(nameStart - 1) > 32) nameStart--;
    const name = tag.slice(nameStart, nameEnd);
    let q = eq + 1;
    while (q < n && tag.charCodeAt(q) <= 32) q++;
    const quote = tag[q];
    if (quote !== '"' && quote !== "'") {
      // Unquoted value (relaxed).
      let end = q;
      while (end < n && tag.charCodeAt(end) > 32 && tag.charCodeAt(end) !== 62) end++;
      out[name] = decodeXmlEntities(tag.slice(q, end));
      p = end;
      continue;
    }
    const close = tag.indexOf(quote, q + 1);
    if (close < 0) break;
    out[name] = decodeXmlEntities(tag.slice(q + 1, close));
    p = close + 1;
  }
  return out;
}

function attribute(tag, name) {
  const value = parseAttributes(tag)[name];
  return value === undefined ? null : value;
}

/**
 * A copy of [text] that does not keep the chunk it was cut from alive. (In V8 a slice can point
 * into its parent string; joining and slicing makes a small string of its own.)
 */
function detach(text) {
  return text.length < 13 ? text : (" " + text).slice(1);
}

function blankToNull(text) {
  if (text == null) return null;
  const t = text.trim();
  return t ? t : null;
}

/** The number written by the ASCII digits s[from, to) (the caller checked they are digits). */
function digitsValue(s, from, to) {
  let value = 0;
  for (let i = from; i < to; i++) value = value * 10 + (s.charCodeAt(i) - 48);
  return value;
}

function toIntOrNull(text) {
  if (text == null) return null;
  return /^[+-]?[0-9]+$/.test(text) ? parseInt(text, 10) : null;
}

/** Days since 1970-01-01 for a calendar date (UTC). */
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.trunc((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.trunc((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Parses an XMLTV time, "YYYYMMDDhhmmss +zzzz" (seconds and offset optional; no offset means
 * UTC), into epoch ms, or NaN.
 */
export function parseXmltvTime(value) {
  if (value == null) return NaN;
  const v = String(value).trim();
  let n = 0;
  while (n < v.length && isDigitCode(v.charCodeAt(n))) n++;
  if (n < 12) return NaN;
  const year = digitsValue(v, 0, 4);
  const month = digitsValue(v, 4, 6);
  const day = digitsValue(v, 6, 8);
  const hour = digitsValue(v, 8, 10);
  const minute = digitsValue(v, 10, 12);
  const second = n >= 14 ? digitsValue(v, 12, 14) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31) return NaN;
  let ms = (daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second) * 1000;
  const offset = v.slice(n).trim();
  if (offset.length >= 5 && (offset[0] === "+" || offset[0] === "-")) {
    const sign = offset[0] === "-" ? -1 : 1;
    // "+0100", and also "+01:00".
    const digits = offset[3] === ":" ? offset.slice(1, 3) + offset.slice(4, 6) : offset.slice(1, 5);
    const oh = toIntOrNull(digits.slice(0, 2)) || 0;
    const om = toIntOrNull(digits.slice(2, 4)) || 0;
    ms -= sign * (oh * 3600000 + om * 60000);
  }
  return ms;
}

function countLetters(text) {
  let count = 0;
  for (const ch of text) {
    // Cased letters, plus scripts without case (CJK, Arabic, ...).
    if (ch.toLowerCase() !== ch.toUpperCase() || ch.codePointAt(0) >= 0x0600) count++;
  }
  return count;
}

function countDigits(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (isDigitCode(text.charCodeAt(i))) count++;
  return count;
}

/**
 * An episode label worth showing ("S2 E5", "Ep. 12", "1x05"), or null for the ids some guides
 * put there instead: long strings of digits ("609178259") and year-based numbers ("S2026E609").
 */
export function cleanEpisode(raw) {
  const t = raw == null ? "" : String(raw).trim();
  if (!t || t.length > 24) return null;
  const letters = countLetters(t);
  const digits = countDigits(t);
  if (digits === 0) return t; // "Part One", "Finale"
  if (letters === 0 && digits > 4) return null; // a plain id
  if (/[0-9]{5,}/.test(t)) return null; // ids with a prefix ("EP012345678")
  const season = /\bS(?:eason)?\s*([0-9]+)/i.exec(t);
  if (season && parseInt(season[1], 10) >= 100) return null; // season numbers that are years
  return t;
}

/**
 * The label for an <episode-num system="..."> value: xmltv_ns ("1.4.0/1") becomes "S2 E5";
 * onscreen (or no system) is kept if it looks like an episode; database ids (dd_progid,
 * thetvdb, imdb, crid...) give null.
 */
export function formatEpisodeNumber(system, value) {
  const text = value == null ? "" : String(value).trim();
  if (!text) return null;
  const sys = system == null ? null : String(system);
  if (sys === "xmltv_ns") {
    const parts = text.split(".");
    const number = (part) => (part == null ? null : toIntOrNull(part.split("/")[0].trim()));
    const season = number(parts[0]);
    const episode = number(parts[1]);
    // A year used as the season (news: "S2026 E609") isn't a real episode number.
    if (season !== null && season >= 100) return null;
    if (season !== null && episode !== null) return `S${season + 1} E${episode + 1}`;
    if (episode !== null) return `E${episode + 1}`;
    return null;
  }
  if (sys !== null && sys !== "onscreen") return null;
  return cleanEpisode(text);
}

const YEAR_IN_PARENS = /[(](19[0-9]{2}|20[0-9]{2})[)]/;

/** "(1990)" in a title or description. Bare numbers are ignored: too easy to misread. */
function yearIn(text) {
  if (!text) return null;
  const m = YEAR_IN_PARENS.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Incremental XMLTV parser. push() text as it arrives (any split), then end().
 * onChannel({ id, names, icon }) is called for every <channel id>, and
 * onProgramme({ channelId, startMs, stopMs, title, subTitle, description, category, episode,
 * icon, year, people }) for every <programme> overlapping [windowStartMs, windowEndMs).
 */
export class XmltvStreamParser {
  constructor({ windowStartMs, windowEndMs, onChannel, onProgramme } = {}) {
    this.windowStartMs = Number.isFinite(windowStartMs) ? windowStartMs : -Infinity;
    this.windowEndMs = Number.isFinite(windowEndMs) ? windowEndMs : Infinity;
    this.onChannel = typeof onChannel === "function" ? onChannel : null;
    this.onProgramme = typeof onProgramme === "function" ? onProgramme : null;
    /** Every channel id the guide's programmes mention, kept or not (for picking a guide channel). */
    this.programmeChannelIds = new Set();
    this.channelCount = 0;
    this.programmeCount = 0;
    this.skippedCount = 0;
    this._buffer = "";
    this._waitFor = 0;
    this._ended = false;
    this._interned = new Map();
  }

  /** Characters held back because they belong to an element that has not been completed yet. */
  get bufferedLength() {
    return this._buffer.length;
  }

  push(chunk) {
    if (this._ended || chunk == null) return;
    const text = String(chunk);
    if (!text) return;
    this._buffer = this._buffer ? this._buffer + text : text;
    if (this._buffer.length < this._waitFor) return;
    this._drain(false);
  }

  /** Reads whatever is left (an element cut off at the end keeps what was read of it). */
  end() {
    if (!this._ended) {
      this._drain(true);
      this._ended = true;
      this._interned.clear();
    }
    return {
      channels: this.channelCount,
      programmes: this.programmeCount,
      skipped: this.skippedCount
    };
  }

  _drain(final) {
    const s = this._buffer;
    let p = 0;
    let incomplete = false;
    this._waitFor = 0;
    for (;;) {
      const lt = s.indexOf("<", p);
      if (lt < 0) {
        p = s.length;
        break;
      }
      p = lt;
      if (lt + 1 >= s.length) {
        incomplete = true;
        break;
      }
      const c = s.charCodeAt(lt + 1);
      if (c === 33 || c === 63 || c === 47) {
        let next;
        if (c === 33) next = skipMarkup(s, lt);
        else if (c === 63) next = s.indexOf("?>", lt + 2) + 2;
        else next = findTagEnd(s, lt) + 1;
        if (next <= 1) {
          incomplete = true;
          break;
        }
        p = next;
        continue;
      }
      if (!isNameStartCode(c)) {
        p = lt + 1;
        continue;
      }
      const gt = findTagEnd(s, lt);
      if (gt < 0) {
        incomplete = true;
        break;
      }
      const name = tagName(s, lt);
      if (name !== "channel" && name !== "programme") {
        p = gt + 1; // <tv>, or anything else: its content is still scanned
        continue;
      }
      let inner = "";
      let after = gt + 1;
      if (s.charCodeAt(gt - 1) !== 47) {
        const close = findClose(s, gt + 1, name, TOP_LEVEL_NAMES);
        if (close === null) {
          if (!final) {
            incomplete = true;
            break;
          }
          inner = s.slice(gt + 1);
          after = s.length;
        } else {
          inner = s.slice(gt + 1, close.innerEnd);
          after = close.after;
        }
      }
      const tag = s.slice(lt, gt + 1);
      if (name === "channel") this._readChannel(tag, inner);
      else this._readProgramme(tag, inner);
      p = after;
    }
    if (final) {
      this._buffer = "";
      return;
    }
    this._buffer = p >= s.length ? "" : detach(s.slice(p));
    if (incomplete) this._waitFor = this._buffer.length + RESCAN_GROWTH;
  }

  _intern(text) {
    if (text == null) return null;
    if (text.length > MAX_INTERNED_LENGTH) return detach(text);
    const known = this._interned.get(text);
    if (known !== undefined) return known;
    if (this._interned.size >= MAX_INTERNED) this._interned.clear();
    const own = detach(text);
    this._interned.set(own, own);
    return own;
  }

  _readChannel(tag, inner) {
    const id = attribute(tag, "id");
    if (id === null) return;
    const names = [];
    let icon = null;
    forEachChild(inner, (name, childTag, childInner) => {
      if (name === "display-name") {
        const text = textContent(childInner).trim();
        if (text) names.push(detach(text));
      } else if (name === "icon") {
        icon = attribute(childTag, "src");
      }
    });
    this.channelCount++;
    if (this.onChannel) {
      this.onChannel({ id: this._intern(id), names, icon: icon === null ? null : detach(icon) });
    }
  }

  _readProgramme(tag, inner) {
    const attrs = parseAttributes(tag);
    const channelId = attrs.channel;
    if (channelId === undefined) {
      this.skippedCount++;
      return;
    }
    const channel = this._intern(channelId);
    this.programmeChannelIds.add(channel);
    const startMs = parseXmltvTime(attrs.start);
    const stopMs = parseXmltvTime(attrs.stop);
    if (
      Number.isNaN(startMs) ||
      Number.isNaN(stopMs) ||
      stopMs <= this.windowStartMs ||
      startMs >= this.windowEndMs
    ) {
      this.skippedCount++;
      return;
    }
    let title = null;
    let subTitle = null;
    let desc = null;
    let category = null;
    let episode = null;
    let icon = null;
    let date = null;
    const people = [];
    forEachChild(inner, (name, childTag, childInner) => {
      switch (name) {
        case "title":
          if (title === null) title = textContent(childInner);
          break;
        case "sub-title":
          if (subTitle === null) subTitle = textContent(childInner);
          break;
        case "desc":
          if (desc === null) desc = textContent(childInner);
          break;
        case "category":
          if (category === null) category = textContent(childInner);
          break;
        case "episode-num": {
          // The on-screen form wins; otherwise the first one that gives a label.
          const system = attribute(childTag, "system");
          if (system === "onscreen" || episode === null) {
            episode = formatEpisodeNumber(system, textContent(childInner));
          }
          break;
        }
        case "icon":
          icon = attribute(childTag, "src");
          break;
        case "date":
          if (date === null) date = textContent(childInner);
          break;
        case "credits":
          forEachChild(childInner, (role, _tag, person) => {
            if (role !== "actor" && role !== "director") return;
            const text = textContent(person).trim();
            if (text) people.push(detach(text));
          });
          break;
        default:
          break;
      }
    });
    // Only a bare year ("1990") is a release year. Many guides put the broadcast or episode air
    // date here instead ("20260929").
    const dateText = date === null ? "" : date.trim();
    const dateYear = dateText.length === 4 ? toIntOrNull(dateText) : null;
    const year =
      dateYear !== null && dateYear >= 1900 && dateYear <= 2100
        ? dateYear
        : (yearIn(title) ?? yearIn(desc));
    let description = blankToNull(desc);
    if (description !== null && description.length > MAX_DESCRIPTION) {
      description = description.slice(0, MAX_DESCRIPTION).trimEnd() + ELLIPSIS;
    }
    this.programmeCount++;
    if (!this.onProgramme) return;
    this.onProgramme({
      channelId: channel,
      startMs,
      stopMs,
      title: this._intern(blankToNull(title) || NO_INFORMATION),
      subTitle: subTitle === null ? null : this._intern(blankToNull(subTitle)),
      description: description === null ? null : detach(description),
      category: this._intern(blankToNull(category)),
      episode: this._intern(episode),
      icon: this._intern(blankToNull(icon)),
      year,
      people: people.slice(0, MAX_PEOPLE)
    });
  }
}
