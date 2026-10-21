/**
 * Live Matches — a Stremio-protocol addon for Nuvio
 *
 * Two sources:
 *
 * 1. Live sport events from the static list (matches.json), rewritten on a
 *    schedule by tools/refresh.js. Nothing is scraped at request time, so if
 *    the source site is down the addon is unaffected.
 *
 * 2. LivePass (web.livepass.app) — queried live, because it has no static
 *    list to cache. It needs an account, so the credentials come from Worker
 *    secrets (lp_email / lp_pass) and never live in the repository.
 *
 * Endpoints
 *   GET /manifest.json
 *   GET /catalog/tv/<id>.json
 *   GET /stream/tv/<id>.json
 *   GET /meta/tv/<id>.json
 *   GET /lp-media?u=<encoded>   (media proxy, carries the session cookie)
 */

/**
 * The event list is fetched from the repository rather than bundled, so a
 * refresh never requires redeploying this Worker. Only this file changing
 * needs a deploy; the data updates on its own.
 */
const LIST_URL =
  "https://raw.githubusercontent.com/onghijkl/Live-matches/refs/heads/main/matches.json";

let cached = null;
let cachedAt = 0;
const CACHE_MS = 5 * 60 * 1000;

async function loadMatches() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return cached;
  try {
    const r = await fetch(LIST_URL, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    if (r.ok) {
      const j = await r.json();
      const list = (j && j.events) || [];
      if (list.length) {
        cached = list;
        cachedAt = now;
      }
    }
  } catch (e) {
    // fall through to whatever we last had
  }
  return cached || [];
}

/* ------------------------------------------------------------- LivePass */

const LP = "https://web.livepass.app";
const LP_CLIENT_HEADER = "x-livepass-client-instance-id";

let lpCookie = null;
let lpCookieAt = 0;
const LP_COOKIE_MS = 30 * 60 * 1000;

function lpInstanceId() {
  const s = LP_CLIENT_HEADER + "=";
  const m = lpCookie ? lpCookie.match(/lp_sid=([^;]+)/) : null;
  return m ? m[1] : "livepass-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/**
 * Read a secret by name, case-insensitively, so LP_EMAIL / Lp_Email /
 * lp_email all work. Cloudflare key names are case-sensitive, and a mismatch
 * here is the difference between a working addon and "secrets are not set".
 */
function secret(env, name) {
  if (!env) return null;
  if (env[name]) return env[name];
  const want = name.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === want) return env[k];
  }
  return null;
}

/** Log in and cache the lp_session cookie. */
async function lpLogin(env) {
  const email = secret(env, "lp_email");
  const pass = secret(env, "lp_pass");
  if (!email || !pass) {
    const have = env ? Object.keys(env).filter(function (k) { return /lp|email|pass/i.test(k); }) : [];
    throw new Error(
      "lp_email/lp_pass secrets are not set on this Worker" +
      (have.length ? " (found similar keys: " + have.join(", ") + ")" : "")
    );
  }

  const r = await fetch(LP + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: email, password: pass })
  });
  if (!r.ok) throw new Error("LivePass login failed: HTTP " + r.status);

  let cookie = "";
  const list = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const all = [];
  for (const c of list) { if (Array.isArray(c)) all.push.apply(all, c); else all.push(c); }
  if (all.length) {
    cookie = all.map(function (c) { return String(c).split(";")[0]; }).join("; ");
  } else {
    const single = r.headers.get("set-cookie");
    if (single) cookie = String(single).split(";")[0];
  }
  if (!cookie) throw new Error("LivePass login returned no session cookie");

  lpCookie = cookie;
  lpCookieAt = Date.now();
  return cookie;
}

/** Authenticated LivePass GET, re-logging in once if the session expired. */
async function lpFetch(path, env, extraHeaders) {
  if (!lpCookie || Date.now() - lpCookieAt > LP_COOKIE_MS) await lpLogin(env);

  async function attempt() {
    const headers = Object.assign(
      { Accept: "application/json", Cookie: lpCookie },
      extraHeaders || {}
    );
    return fetch(LP + path, { headers: headers, cf: { cacheTtl: 60 } });
  }

  let r = await attempt();
  if (r.status === 401) {
    await lpLogin(env);
    r = await attempt();
  }
  return r;
}

/** Channel name lookup, so a stream title can say "CBS" rather than the id. */
let lpChanCache = null;
let lpChanAt = 0;

async function lpChannelName(id, env) {
  if (!lpChanCache || Date.now() - lpChanAt > LP_COOKIE_MS) {
    const r = await lpFetch("/api/catalog", env);
    if (r.ok) {
      const j = await r.json();
      lpChanCache = {};
      for (const c of j.channels || []) lpChanCache[c.id] = c.name;
      lpChanAt = Date.now();
    }
  }
  return (lpChanCache && lpChanCache[id]) || id;
}

/** LivePass channel catalog -> Stremio metas. */
async function lpChannelMetas(env, filter) {
  const r = await lpFetch("/api/catalog", env);
  if (!r.ok) return [];
  const j = await r.json();
  const chans = j.channels || [];

  let list = chans;
  if (filter === "sports") {
    list = chans.filter(function (c) {
      return /sport/i.test((c.category || "") + " " + (c.niche || "") + " " + (c.subcategory || ""));
    });
  } else if (filter === "news") {
    list = chans.filter(function (c) {
      return /news/i.test((c.category || "") + " " + (c.niche || "") + " " + (c.subcategory || ""));
    });
  }

  return list.slice(0, 500).map(function (c) {
    return {
      id: "lp:ch:" + c.id,
      type: "tv",
      name: c.name,
      description: [c.country_name || c.country, c.category, c.quality]
        .filter(Boolean)
        .join(" \u2022 "),
      poster: c.logo ? LP + c.logo : undefined,
      posterShape: "square",
      genres: c.category ? [c.category] : undefined
    };
  });
}

/** LivePass live events (with scores) -> Stremio metas. */
async function lpEventMetas(env) {
  const now = Date.now();
  const from = now - 12 * 60 * 60 * 1000;
  const to = now + 36 * 60 * 60 * 1000;
  const q =
    "/api/events/events?from=" + from + "&to=" + to +
    "&limit=60&order=live&offset=0&includeLive=1&playback=only&odds=0&shape=card";
  const r = await lpFetch(q, env);
  if (!r.ok) return [];
  const j = await r.json();
  const pbe = j.playbackByEvent || {};
  const out = [];

  for (const eventId of Object.keys(pbe)) {
    const sources = pbe[eventId] || [];
    for (const s of sources) {
      if (!s.playable && !s.mediaReady) continue;
      const bits = [];
      if (s.label) bits.push(s.label);
      if (s.country) bits.push(s.country);
      if (s.language) bits.push(s.language);
      out.push({
        id: "lp:ev:" + eventId + ":" + s.id,
        type: "tv",
        name: s.label || "Live Event",
        description: bits.join(" \u2022 "),
        posterShape: "square"
      });
      break; // one entry per event is enough
    }
  }
  return out;
}

/** Resolve a LivePass source id to a playable stream. */
async function lpStreams(id, env) {
  const prefix = "lp:";
  if (id.indexOf(prefix) !== 0) return [];
  const body = id.slice(prefix.length);

  let type = null;
  let eventId = null;
  let sourceId = null;
  let title = "";

  if (body.indexOf("ch:") === 0) {
    type = "channel";
    title = body.slice(3);
  } else if (body.indexOf("ev:") === 0) {
    type = "event";
    const rest = body.slice(3);
    const cut = rest.indexOf(":");
    eventId = cut > 0 ? rest.slice(0, cut) : rest;
    sourceId = cut > 0 ? rest.slice(cut + 1) : "";
  } else {
    return [];
  }

  const params = new URLSearchParams();
  params.set("type", type);
  if (type === "event") {
    params.set("id", eventId);
    if (sourceId) params.set("source", sourceId);
  } else {
    title = await lpChannelName(body.slice(3), env);
    params.set("id", body.slice(3));
  }
  if (title) params.set("title", title);

  const headers = {};
  headers[LP_CLIENT_HEADER] = lpInstanceId();

  const r = await lpFetch("/api/player/playback-url?" + params.toString(), env, headers);
  if (!r.ok) return [];
  const j = await r.json();
  if (!j.ok || !j.playbackUrl) return [];

  // The media endpoint needs the session cookie. Nuvio supports a headers
  // object on a stream, and applies it to the manifest and its segments, so
  // this usually suffices. /lp-media is the fallback if it does not.
  return [
    {
      name: "LivePass",
      title: (title || "Live") + (j.selectedSourceLabel ? " \u2022 " + j.selectedSourceLabel : ""),
      url: j.playbackUrl,
      quality: "Auto",
      headers: { Cookie: lpCookie },
      behaviorHints: { notWebReady: false, bingeGroup: "livepass" }
    }
  ];
}

/* ------------------------------------------------------------------ core */

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
    version: "1.1.0",
    name: "Live Matches",
    description:
      "Live sport events and live TV channels. LivePass channels stream in 1080p H.264.",
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
      { type: "tv", id: "live-matches-other", name: "Other Sport" },
      { type: "tv", id: "lp-live-tv", name: "Live TV" },
      { type: "tv", id: "lp-live-sports", name: "Live Sports" },
      { type: "tv", id: "lp-live-news", name: "Live News" }
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

async function catalogRows(id, env) {
  if (id === "lp-live-tv") return lpChannelMetas(env, null);
  if (id === "lp-live-sports") return lpChannelMetas(env, "sports");
  if (id === "lp-live-news") return lpChannelMetas(env, "news");

  const MATCHES = await loadMatches();
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

async function streamsFor(id, env) {
  if (id.indexOf("lp:") === 0) return lpStreams(id, env);

  const MATCHES = await loadMatches();
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

/**
 * Media proxy: fetches LivePass media with the session cookie attached and
 * rewrites any relative segment URLs to come back through here. Used when the
 * player does not forward a stream's headers to its segments.
 */
async function lpMedia(target, env) {
  if (!lpCookie || Date.now() - lpCookieAt > LP_COOKIE_MS) await lpLogin(env);

  const r = await fetch(target, {
    headers: { Cookie: lpCookie },
    cf: { cacheTtl: 10, cacheEverything: false }
  });
  if (!r.ok) return new Response("upstream error", { status: r.status });

  const ct = r.headers.get("content-type") || "";
  if (ct.indexOf("mpegurl") === -1) return r;

  const text = await r.text();
  const base = target;
  const rewritten = text
    .split("\n")
    .map(function (line) {
      const t = line.trim();
      if (!t || t.charAt(0) === "#") return line;
      const abs = t.indexOf("http") === 0 ? t : absJoin(base, t);
      return "  /lp-media?u=" + encodeURIComponent(abs);
    })
    .join("\n");

  return new Response(rewritten, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=5"
    }
  });
}

function absJoin(base, rel) {
  const m = base.match(/^(https?:\/\/[^\/]+)/);
  const origin = m ? m[1] : "";
  if (rel.charAt(0) === "/") return origin + rel;
  return base.substring(0, base.lastIndexOf("/") + 1) + rel;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return cors("", 204);

    try {
      if (path === "/" || path === "/manifest.json") {
        return cors(JSON.stringify(manifest()));
      }

      if (path === "/lp-media") {
        const u = url.searchParams.get("u");
        if (!u) return new Response("missing u", { status: 400 });
        return lpMedia(u, env);
      }

      const cat = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/(.+?))?\.json$/);
      if (cat) {
        return cors(JSON.stringify({ metas: await catalogRows(cat[2], env) }));
      }

      const st = path.match(/^\/stream\/([^/]+)\/(.+)\.json$/);
      if (st) {
        return cors(JSON.stringify({ streams: await streamsFor(decodeURIComponent(st[2]), env) }));
      }

      const mt = path.match(/^\/meta\/([^/]+)\/(.+)\.json$/);
      if (mt) {
        const id = decodeURIComponent(mt[2]);
        if (id.indexOf("lp:") === 0) {
          return cors(JSON.stringify({ meta: { id: id, type: "tv", name: id } }));
        }
        const MATCHES = await loadMatches();
        const m = MATCHES.find(function (x) { return x.id === id; });
        return cors(JSON.stringify({ meta: m ? toMeta(m) : null }));
      }

      return cors(JSON.stringify({ error: "not found", path: path }), 404);
    } catch (e) {
      return cors(JSON.stringify({ error: String(e && e.message ? e.message : e) }), 500);
    }
  }
};
