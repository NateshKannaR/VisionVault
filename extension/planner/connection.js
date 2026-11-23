// Shared URL policy for the panel and service worker.
globalThis.PlannerConnection = {
  defaultUrl: "http://127.0.0.1:8000/api/agent/step",

  resolve(address, token = "") {
    const url = new URL(address);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("Use HTTPS for a remote planner or HTTP on localhost.");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("Enter a planner URL without credentials, a query, or a fragment.");
    }
    if ((!loopback || token) && !/^[!-~]{32,}$/.test(token)) {
      throw new Error("Enter a planner token with at least 32 characters and no spaces.");
    }

    const pathname = url.pathname.replace(/\/+$/, "");
    const legacy = pathname.endsWith("/plan-action");
    const base = url.origin + pathname.replace(/\/(?:api\/agent\/step(?:\/stream)?|plan-action)$/, "");
    return {
      step: base + (legacy ? "/plan-action" : "/api/agent/step/stream"),
      health: base + "/health",
      authorization: token ? { Authorization: "Bearer " + token } : {},
    };
  },
};
