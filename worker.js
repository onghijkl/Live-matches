/**
 * Live Matches — a Stremio-protocol addon for Nuvio
 *
 * Serves live sporting events whose streams sit on unsigned CDN endpoints, so
 * playback survives the source site going away. The channel list is a static
 * module (matches.js) rewritten on a schedule by tools/refresh.js — nothing is
 * scraped at request time, so if the source site is down the addon is
 * unaffected.
 *
 * Endpoints
 *   GET /manifest.json
 *   GET /catalog/tv/<id>.json
 *   GET /stream/tv/<id>.json
 */

import { MATCHES, REFRESHED_AT } from "./matches.js";

const SITE = "https://tflix.su";

function cors(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Cache-Control": "public, max-age=120"
    }
  });
}

function manifest() {
  return {
    id: "org.ong.livematches",
    version: "1.0.0",
    name: "Live Matches",
    description:
      "Live sport channels. Streams are served from unsigned CDN endpoints so they keep working independently of the source site.",
    logo: SITE + "/favicon.ico",
    resources: [
      { name: "catalog", types: ["tv"] },
      { name: "meta", types: ["tv"] },
      { name: "stream", types: ["tv"] }
    ],
    types: ["tv"],
    catalogs: [
      { type: "tv", id: "live-matches", name: "Live Matches" },
      { type: "tv", id: "live-matches-football", name: "Football" },
      { type: "tv", id: "live-matches-other", name: "Other Sport" }
    ]
  };
}

/** Coarse grouping for the catalog rows. */
function bucket(m) {
  const n = ((m.sport || "") + " " + (m.competition || "") + " " + (m.name || "")).toLowerCase();
  if (/football|soccer|liga|premier|serie|bundes|ligue|ucl|uel|libertadores/.test(n)) return "football";
  return "other";
}

/** ISO kick-off -> "20 Oct 20:00" */
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(5, 10).replace("-", " ") + " " + d.toISOString().slice(11, 16) + " UTC";
}

function toMeta(m) {
  const bits = [];
  if (m.status === "live") bits.push("\u2022 LIVE");
  else if (m.starts_at) bits.push(when(m.starts_at));
  if (m.competition) bits.push(m.competition);
  if (m.channel_count) bits.push(m.channel_count + (m.channel_count === 1 ? " channel" : " channels"));

  return {
    id: m.id,
    type: "tv",
    name: m.name,
    description: bits.join(" \u2022 "),
    // Nuvio renders a square tile for tv-type catalog entries.
    posterShape: "square",
    genres: m.sport ? [m.sport] : undefined
  };
}

function catalogRows(id) {
  const want = id === "live-matches-football" ? "football"
    : id === "live-matches-other" ? "other"
    : null;

  return MATCHES
    .filter(function (m) { return !want || bucket(m) === want; })
    // Live events first, then whatever is coming up.
    .sort(function (a, b) {
      if (a.status === "live" && b.status !== "live") return -1;
      if (b.status === "live" && a.status !== "live") return 1;
      return String(a.starts_at || "").localeCompare(String(b.starts_at || ""));
    })
    .map(toMeta);
}

function streamsFor(id) {
  const m = MATCHES.find(function (x) { return x.id === id || x.name === id; });
  if (!m) return [];

  // One entry per verified channel carrying the event.
  return (m.channels || []).map(function (ch) {
    const bits = [ch.quality, ch.language, ch.country].filter(Boolean);
    return {
      name: "Live",
      title: (m.name || "Live") + (bits.length ? " \u2022 " + bits.join(" \u2022 ") : ""),
      url: ch.url,
      quality: ch.quality || "Auto",
      behaviorHints: { notWebReady: false, bingeGroup: "livematches" }
    };
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return cors("", 204);

    try {
      if (path === "/" || path === "/manifest.json") {
        return cors(JSON.stringify(manifest()));
      }

      const cat = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/(.+?))?\.json$/);
      if (cat) {
        return cors(JSON.stringify({ metas: catalogRows(cat[2]) }));
      }

      const st = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
      if (st) {
        return cors(JSON.stringify({ streams: streamsFor(decodeURIComponent(st[2])) }));
      }

      const mt = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
      if (mt) {
        const m = MATCHES.find(function (x) {
          return x.id === decodeURIComponent(mt[2]);
        });
        return cors(JSON.stringify({ meta: m ? toMeta(m) : null }));
      }

      return cors(JSON.stringify({ error: "not found", path: path }), 404);
    } catch (e) {
      return cors(JSON.stringify({ error: String(e && e.message ? e.message : e) }), 500);
    }
  }
};
