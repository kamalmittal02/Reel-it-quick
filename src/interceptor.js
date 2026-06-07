// Runs in the page's MAIN world so it can wrap the same fetch/XHR that
// Instagram itself uses, capture JSON responses, and (crucially) issue the
// profile-reels pagination request *itself* so the user never has to scroll.
//
// Two ways to drive the paginated /api/v1/clips/user/ endpoint:
//   1. Replay a template captured from Instagram's own organic call.
//   2. If none was seen (the grid often uses GraphQL), construct the request
//      from the profile's user id + the csrftoken cookie + the web app id.

(function () {
  const TAG = "IGRF_NETWORK";
  const STATUS = "IGRF_STATUS";
  const CONTROL = "IGRF_CONTROL";

  const REELS_ENDPOINT = "/api/v1/clips/user/";
  const APP_ID = "936619743392459"; // Instagram web app id.
  const MAX_AGE_DAYS = 60; // Hard limit: never fetch reels older than ~2 months.
  const PAGE_SIZE = 12;
  const MAX_PAGES = 100;

  let reelsRequestTemplate = null; // { url, method, headers, bodyText }
  let lastPaging = null; // { max_id, more_available }
  let autoFetchRunning = false;
  let stopRequested = false;

  // username (lowercase) -> user id, learned from captured payloads.
  const userIdByName = new Map();

  function isInteresting(url) {
    if (typeof url !== "string") return false;
    return (
      url.includes("/api/v1/") ||
      url.includes("/graphql") ||
      url.includes("graphql/query")
    );
  }

  function forward(url, payload) {
    if (!payload || typeof payload !== "object") return;
    try {
      window.postMessage({ source: TAG, url, payload }, window.location.origin);
    } catch (_) {}
  }

  function status(detail) {
    try {
      window.postMessage(
        Object.assign({ source: STATUS }, detail),
        window.location.origin
      );
    } catch (_) {}
  }

  function rememberPaging(payload) {
    if (payload && payload.paging_info && typeof payload.paging_info === "object") {
      lastPaging = payload.paging_info;
    }
  }

  // Learn username -> id from any payload shape we recognize.
  function learnUsers(node, depth) {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      for (const c of node) learnUsers(c, depth + 1);
      return;
    }
    const uname = node.username;
    const uid = node.pk || node.id;
    if (typeof uname === "string" && uid != null) {
      userIdByName.set(uname.toLowerCase(), String(uid));
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") learnUsers(v, depth + 1);
    }
  }

  function currentUsername() {
    const seg = (location.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
    const reserved = new Set([
      "reels", "reel", "explore", "p", "direct", "stories",
      "accounts", "about", "developer",
    ]);
    return reserved.has(seg) ? "" : seg;
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  // Resolve the profile user id, fetching web_profile_info as a last resort.
  async function resolveUserId() {
    const uname = currentUsername();
    if (!uname) return null;
    if (userIdByName.has(uname)) return userIdByName.get(uname);

    try {
      const res = await originalFetch(
        "/api/v1/users/web_profile_info/?username=" + encodeURIComponent(uname),
        {
          headers: { "x-ig-app-id": APP_ID, "x-requested-with": "XMLHttpRequest" },
          credentials: "include",
        }
      );
      const data = await res.json();
      forward("web_profile_info", data);
      const id = data && data.data && data.data.user && data.data.user.id;
      if (id) {
        userIdByName.set(uname, String(id));
        return String(id);
      }
    } catch (_) {}
    return null;
  }

  async function captureTemplate(reqArg, init) {
    try {
      let url, method, headers = {}, bodyText = null;
      if (typeof Request !== "undefined" && reqArg instanceof Request) {
        const r = reqArg.clone();
        url = r.url;
        method = r.method || "POST";
        r.headers.forEach((v, k) => (headers[k] = v));
        bodyText = await r.clone().text();
      } else {
        url = String(reqArg);
        method = (init && init.method) || "POST";
        if (init && init.headers) {
          if (init.headers instanceof Headers) {
            init.headers.forEach((v, k) => (headers[k] = v));
          } else if (Array.isArray(init.headers)) {
            init.headers.forEach(([k, v]) => (headers[k] = v));
          } else {
            Object.assign(headers, init.headers);
          }
        }
        if (init && typeof init.body === "string") bodyText = init.body;
      }
      if (bodyText != null) reelsRequestTemplate = { url, method, headers, bodyText };
    } catch (_) {}
  }

  function setParam(bodyText, key, value) {
    const params = new URLSearchParams(bodyText || "");
    if (value == null || value === "") params.delete(key);
    else params.set(key, String(value));
    return params.toString();
  }

  // Build a clips/user request from scratch when no template was captured.
  async function buildRequest() {
    if (reelsRequestTemplate) return reelsRequestTemplate;
    const userId = await resolveUserId();
    if (!userId) return null;

    const body =
      "target_user_id=" + encodeURIComponent(userId) +
      "&page_size=" + PAGE_SIZE +
      "&include_feed_video=true";

    reelsRequestTemplate = {
      url: location.origin + REELS_ENDPOINT,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-ig-app-id": APP_ID,
        "x-csrftoken": getCookie("csrftoken"),
        "x-requested-with": "XMLHttpRequest",
      },
      bodyText: body,
    };
    return reelsRequestTemplate;
  }

  function oldestTakenAt(payload) {
    let oldest = Infinity;
    const items = (payload && payload.items) || [];
    for (const it of items) {
      const m = it && (it.media || it);
      const t = m && Number(m.taken_at);
      if (Number.isFinite(t) && t < oldest) oldest = t;
    }
    return oldest === Infinity ? null : oldest;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function autoFetch() {
    if (autoFetchRunning) return;
    autoFetchRunning = true;
    stopRequested = false;
    status({ phase: "start" });

    const template = await buildRequest();
    if (!template) {
      autoFetchRunning = false;
      status({ phase: "error", reason: "no-user" });
      return;
    }

    const cutoff = Math.floor(Date.now() / 1000) - MAX_AGE_DAYS * 86400;
    let pages = 0;
    let maxId = lastPaging && lastPaging.max_id;
    let more = true;
    let reachedOld = false;

    try {
      while (more && pages < MAX_PAGES && !stopRequested) {
        pages++;
        const body = setParam(template.bodyText, "max_id", maxId);
        let data;
        try {
          const res = await originalFetch(template.url, {
            method: template.method,
            headers: template.headers,
            body,
            credentials: "include",
          });
          if (!res.ok) {
            status({ phase: "error", reason: "http-" + res.status });
            break;
          }
          data = await res.json();
        } catch (_) {
          status({ phase: "error", reason: "request-failed" });
          break;
        }

        forward(template.url, data);
        rememberPaging(data);

        const oldest = oldestTakenAt(data);
        if (oldest != null && oldest < cutoff) reachedOld = true;

        const p = data.paging_info || {};
        more = !!p.more_available && !reachedOld;
        maxId = p.max_id;

        status({ phase: "progress", pages, more });
        await sleep(600 + Math.floor(Math.random() * 500));
      }
      status({
        phase: stopRequested ? "stopped" : "done",
        pages,
        reachedOld,
      });
    } finally {
      autoFetchRunning = false;
      stopRequested = false;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== CONTROL) return;
    if (d.action === "autofetch") autoFetch();
    else if (d.action === "stop") stopRequested = true;
  });

  // --- Wrap fetch -----------------------------------------------------------
  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (...args) {
      const req = args[0];
      const init = args[1];
      const url = typeof req === "string" ? req : req && req.url;
      if (url && url.includes(REELS_ENDPOINT)) captureTemplate(req, init);

      return originalFetch.apply(this, args).then((res) => {
        if (isInteresting(url)) {
          res
            .clone()
            .json()
            .then((data) => {
              learnUsers(data, 0);
              rememberPaging(data);
              forward(url, data);
            })
            .catch(() => {});
        }
        return res;
      });
    };
  }

  // --- Wrap XMLHttpRequest ---------------------------------------------------
  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    const open = OriginalXHR.prototype.open;
    const send = OriginalXHR.prototype.send;
    OriginalXHR.prototype.open = function (method, url, ...rest) {
      this.__igrfUrl = url;
      return open.call(this, method, url, ...rest);
    };
    OriginalXHR.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        const url = this.__igrfUrl;
        if (!isInteresting(url)) return;
        const type = this.responseType;
        if (type !== "" && type !== "text") return;
        try {
          const data = JSON.parse(this.responseText);
          learnUsers(data, 0);
          rememberPaging(data);
          forward(url, data);
        } catch (_) {}
      });
      return send.apply(this, args);
    };
  }
})();
