/**
 * Cloudflare Pages entry point (advanced mode).
 *
 * Pages runs code only from a `_worker.js` in the project's output directory,
 * so this file must sit alongside worker.js. The output directory for this
 * project should be the repository root.
 *
 * The Worker needs the LivePass credentials, which are Worker secrets
 * (lp_email / lp_pass) — they are never in the repository. Pages exposes
 * secrets through the `env` argument, so it is passed straight through.
 */

import worker from "./worker.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    const isAddonRoute =
      path === "/" ||
      path === "/manifest.json" ||
      path === "/lp-media" ||
      /^\/catalog\/[^/]+\/.+\.json$/.test(path) ||
      /^\/stream\/[^/]+\/.+\.json$/.test(path) ||
      /^\/meta\/[^/]+\/.+\.json$/.test(path);

    if (isAddonRoute) return worker.fetch(request, env);

    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
