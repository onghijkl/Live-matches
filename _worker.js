/**
 * Cloudflare Pages entry point (advanced mode).
 *
 * Pages runs code only from a `_worker.js` in the project's output directory,
 * so this file must sit alongside worker.js. The output directory for this
 * project should be the repository root.
 */

import worker from "./worker.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    const isAddonRoute =
      path === "/" ||
      path === "/manifest.json" ||
      /^\/catalog\/[^/]+\/.+\.json$/.test(path) ||
      /^\/stream\/[^/]+\/.+\.json$/.test(path) ||
      /^\/meta\/[^/]+\/.+\.json$/.test(path);

    if (isAddonRoute) return worker.fetch(request);

    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
