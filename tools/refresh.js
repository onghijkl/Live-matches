#!/usr/bin/env node
/**
 * Rebuild matches.js — as live EVENTS, not channels.
 *
 * The source site embeds a full events array in its page: title, sport,
 * competition, kick-off time, live status, and the channels carrying it. This
 * reads that array and, for every channel on every event, resolves the embed
 * slug to its stream on the open CDN and verifies it actually answers.
 *
 * Only verified channels are written, and an event is only written if at least
 * one of its channels verified — so the list never contains a match that cannot
 * actually be watched.
 *
 *   node tools/refresh.js
 *
 * Nothing here runs at request time. That is what keeps the addon working when
 * the source site is down.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SITE = "https://tflix.su";

/**
 * The open CDN. The player-facing URL this replaces carries a hash and an
 * expiry; the bare path serves the same playlist without either, so no signing
 * step is needed and nothing expires.
 *
 * If the CDN ever moves, this is the one line to change.
 */
const CDN = "https://vix.cdnfan.site/tflix/";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const VERIFY_MS = 7000;

/** Pull the "events":[...] array out of the page by balanced brackets. */
function extractEvents(html) {
  const at = html.indexOf('"events":[');
  if (at < 0) return null;
  const start = html.indexOf("[", at);

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

/** .../embed/SKY-SPORTS-MAIN-EVENT-UK  ->  SKY-SPORTS-MAIN-EVENT-UK */
function slugFromEmbed(url) {
  if (!url) return null;
  const m = String(url).match(/\/embed\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

async function live(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(function () {
    ctl.abort();
  }, ms || VERIFY_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal });
    if (!r.ok) return false;
    const t = await r.text();
    return t.indexOf("#EXTM3U") !== -1;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Check every distinct channel slug once, then reuse the result. */
async function verifySlugs(slugs) {
  const cache = {};
  await Promise.all(
    slugs.map(async function (s) {
      cache[s] = await live(CDN + s + ".m3u8");
    })
  );
  return cache;
}

async function main() {
  let html;
  try {
    const r = await fetch(SITE + "/", { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("source site returned " + r.status);
    html = await r.text();
  } catch (e) {
    // Never wipe a good list because the site was briefly unreachable.
    console.error("[refresh] discovery failed:", e.message);
    console.error("[refresh] leaving matches.js untouched");
    process.exit(0);
  }

  const events = extractEvents(html);
  if (!events || !events.length) {
    console.error("[refresh] no events found in the page — leaving matches.js untouched");
    process.exit(0);
  }
  console.log("[refresh] " + events.length + " events in the feed");

  // Gather every channel slug across every event, then verify once each.
  const slugs = [];
  for (const ev of events) {
    for (const ch of ev.channels || []) {
      const s = slugFromEmbed(ch.embed_url);
      if (s && !slugs.includes(s)) slugs.push(s);
    }
  }
  console.log("[refresh] " + slugs.length + " distinct channels to verify");

  const ok = await verifySlugs(slugs);
  const working = slugs.filter(function (s) {
    return ok[s];
  });
  console.log("[refresh] " + working.length + " of " + slugs.length + " channels verified");

  const out = [];
  for (const ev of events) {
    const live = [];
    for (const ch of ev.channels || []) {
      const s = slugFromEmbed(ch.embed_url);
      if (!s || !ok[s]) continue;
      live.push({
        name: ch.name || s,
        quality: ch.quality || undefined,
        language: ch.language || undefined,
        country: ch.country || undefined,
        slug: s,
        url: CDN + s + ".m3u8"
      });
    }
    // An event with nothing playable is not worth listing.
    if (!live.length) continue;

    out.push({
      id: "tflix:" + (ev.id || ev.watch_url || ev.title),
      name: ev.title || "Live",
      sport: ev.sport || "Sport",
      competition: ev.competition || "",
      status: ev.status || "scheduled",
      starts_at: ev.starts_at || null,
      channel_count: live.length,
      channels: live
    });
  }

  // Live first, then by kick-off.
  out.sort(function (a, b) {
    if (a.status === "live" && b.status !== "live") return -1;
    if (b.status === "live" && a.status !== "live") return 1;
    return String(a.starts_at || "").localeCompare(String(b.starts_at || ""));
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const body =
    "/**\n" +
    " * Live events.\n" +
    " *\n" +
    " * GENERATED by tools/refresh.js on a schedule \u2014 do not edit by hand.\n" +
    " *\n" +
    " * Each event lists only channels that were verified against the open CDN at\n" +
    " * build time, so every entry here is watchable without a signature or a\n" +
    " * decryption key.\n" +
    " */\n\n" +
    "export const REFRESHED_AT = " + JSON.stringify(new Date().toISOString()) + ";\n\n" +
    "export const MATCHES = " + JSON.stringify(out, null, 2) + ";\n";

  writeFileSync(join(here, "..", "matches.js"), body);

  const liveCount = out.filter(function (e) {
    return e.status === "live";
  }).length;
  console.log(
    "[refresh] wrote " + out.length + " events (" + liveCount + " live), " +
    working.length + " working channels"
  );
}

main().catch(function (e) {
  console.error("[refresh] fatal:", e);
  process.exit(1);
});
