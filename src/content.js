// Controller + UI. Runs in the ISOLATED world. Receives raw JSON payloads
// from the MAIN-world interceptor, extracts reels, keeps an in-memory store
// (nothing persisted), and renders a floating panel for search + grouping.

(function () {
  const VERSION = "1.2"; // Bump on each build so the running version is visible.
  const TAG = "IGRF_NETWORK";
  const TTL_MS = 30 * 60 * 1000; // Cached reels expire after 30 minutes.
  const MAX_AGE_DAYS = 60; // Hard limit: ignore reels older than ~2 months.

  const store = new Map(); // id -> { reel, ts }
  let currentProfile = profileKey();

  const state = {
    open: false,
    minimized: false,
    query: "",
    activeTerm: null, // { term, type } or null
    sort: "views", // 'views' | 'recent'
    fetchStatus: "idle", // 'idle' | 'running' | 'done' | 'error'
    fetchPages: 0,
  };

  let autoStartedProfile = null; // Profile we've already auto-loaded.

  // --- Data intake ----------------------------------------------------------
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG) return;
    if (!window.IGRF) return;

    // A profile switch invalidates the cache so groups stay scoped per-profile.
    const key = profileKey();
    if (key !== currentProfile) {
      currentProfile = key;
      store.clear();
    }

    const owner = key === "__global__" ? null : key.toLowerCase();
    let added = 0;
    for (const reel of window.IGRF.extractReels(data.payload)) {
      // Only cache reels that belong to the profile being viewed.
      if (owner && reel.owner && reel.owner !== owner) continue;
      const existing = store.get(reel.id);
      if (!existing) added++;
      // Never let a caption-less copy overwrite one that already has a caption.
      const reelToStore =
        existing && existing.reel.caption && !reel.caption
          ? existing.reel
          : reel;
      store.set(reel.id, { reel: reelToStore, ts: Date.now() });
    }
    if (added > 0) scheduleRender();
  });

  function profileKey() {
    const seg = location.pathname.split("/").filter(Boolean)[0] || "";
    const reserved = new Set([
      "reels", "reel", "explore", "p", "direct", "stories",
      "accounts", "about", "developer",
    ]);
    return reserved.has(seg) ? "__global__" : seg;
  }

  // Purge TTL-expired entries, then return reels scoped to the current
  // profile and filtered to the last MAX_AGE_DAYS.
  function liveReels() {
    const now = Date.now();
    for (const [id, e] of store) {
      if (now - e.ts > TTL_MS) store.delete(id);
    }
    const cutoff = Math.floor(now / 1000) - MAX_AGE_DAYS * 86400;
    const owner = currentProfile === "__global__" ? null : currentProfile.toLowerCase();
    const out = [];
    for (const { reel } of store.values()) {
      if (reel.takenAt != null && reel.takenAt < cutoff) continue;
      if (owner && reel.owner && reel.owner !== owner) continue;
      out.push(reel);
    }
    return out;
  }

  // --- Render scheduling ----------------------------------------------------
  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 200);
  }

  // --- UI shell -------------------------------------------------------------
  let fab, panel, els;
  let uiReady = false;

  function buildUI() {
    if (uiReady || document.getElementById("igrf-fab")) return;
    if (!document.body) return;

    fab = document.createElement("button");
    fab.id = "igrf-fab";
    fab.className = "igrf-fab";
    fab.title = "Reel It Quick";
    fab.textContent = "Reels";
    fab.addEventListener("click", togglePanel);

    panel = document.createElement("div");
    panel.id = "igrf-panel";
    panel.className = "igrf-panel igrf-hidden";
    panel.innerHTML = `
      <div class="igrf-header" data-role="header">
        <span class="igrf-grip" title="Drag to move">⠿</span>
        <span class="igrf-title">Reel It Quick</span>
        <span class="igrf-ver">v${VERSION}</span>
        <span class="igrf-count" data-role="count">0</span>
        <button class="igrf-icon-btn" data-role="min" title="Minimize">–</button>
        <button class="igrf-icon-btn" data-role="close" title="Close">×</button>
      </div>
      <div class="igrf-body" data-role="body">
        <div class="igrf-controls">
          <input type="text" class="igrf-search" data-role="search"
                 placeholder="Search captions / hashtags..." />
          <select class="igrf-sort" data-role="sort">
            <option value="views">Most viewed</option>
            <option value="recent">Recently loaded</option>
          </select>
        </div>
        <div class="igrf-controls igrf-controls-row2">
          <button class="igrf-load" data-role="load">Load all reels</button>
        </div>
        <div class="igrf-status igrf-hidden" data-role="status"></div>
        <div class="igrf-groups-label">Hashtags</div>
        <div class="igrf-groups" data-role="groups"></div>
        <div class="igrf-results" data-role="results"></div>
        <div class="igrf-hint">Opens and loads this profile's reels automatically.</div>
      </div>
    `;

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    els = {
      header: panel.querySelector('[data-role="header"]'),
      count: panel.querySelector('[data-role="count"]'),
      search: panel.querySelector('[data-role="search"]'),
      sort: panel.querySelector('[data-role="sort"]'),
      load: panel.querySelector('[data-role="load"]'),
      status: panel.querySelector('[data-role="status"]'),
      groups: panel.querySelector('[data-role="groups"]'),
      results: panel.querySelector('[data-role="results"]'),
    };

    panel.querySelector('[data-role="close"]').addEventListener("click", togglePanel);
    panel.querySelector('[data-role="min"]').addEventListener("click", toggleMinimize);
    els.search.addEventListener("input", (e) => {
      state.query = e.target.value.trim().toLowerCase();
      render();
    });
    els.sort.addEventListener("change", (e) => {
      state.sort = e.target.value;
      render();
    });
    els.load.addEventListener("click", onLoadClick);
    makeDraggable(els.header, panel);

    uiReady = true;
    render();
  }

  // --- Minimize + drag ------------------------------------------------------
  function toggleMinimize() {
    state.minimized = !state.minimized;
    panel.classList.toggle("igrf-minimized", state.minimized);
    const btn = panel.querySelector('[data-role="min"]');
    if (btn) {
      btn.textContent = state.minimized ? "▢" : "–";
      btn.title = state.minimized ? "Restore" : "Minimize";
    }
  }

  function makeDraggable(handle, el) {
    let startX, startY, origLeft, origTop, dragging = false;
    handle.style.cursor = "move";

    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return; // let header buttons work
      dragging = true;
      const rect = el.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      startX = e.clientX;
      startY = e.clientY;
      el.style.left = origLeft + "px";
      el.style.top = origTop + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
      e.preventDefault();
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
    });

    function onMove(e) {
      if (!dragging) return;
      let nl = origLeft + (e.clientX - startX);
      let nt = origTop + (e.clientY - startY);
      nl = Math.max(0, Math.min(nl, window.innerWidth - 60));
      nt = Math.max(0, Math.min(nt, window.innerHeight - 40));
      el.style.left = nl + "px";
      el.style.top = nt + "px";
    }
    function onUp() {
      dragging = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    }
  }

  // --- Auto-fetch control ---------------------------------------------------
  function onLoadClick() {
    if (state.fetchStatus === "running") {
      window.postMessage({ source: "IGRF_CONTROL", action: "stop" }, location.origin);
      return;
    }
    state.fetchStatus = "running";
    state.fetchPages = 0;
    window.postMessage({ source: "IGRF_CONTROL", action: "autofetch" }, location.origin);
    updateLoadButton();
    setStatus("Starting...");
  }

  function updateLoadButton() {
    if (!els) return;
    els.load.textContent =
      state.fetchStatus === "running" ? "Stop loading" : "Load all reels";
    els.load.classList.toggle("igrf-load-running", state.fetchStatus === "running");
  }

  function setStatus(text) {
    if (!els) return;
    if (!text) {
      els.status.classList.add("igrf-hidden");
      return;
    }
    els.status.classList.remove("igrf-hidden");
    els.status.textContent = text;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== "IGRF_STATUS") return;

    if (d.phase === "start") {
      setStatus("Loading reels...");
      render();
    } else if (d.phase === "progress") {
      state.fetchPages = d.pages;
      render();
      setStatus(
        "Loaded " + liveReels().length + " reels (page " + d.pages + ")" +
          (d.more ? "..." : "")
      );
    } else if (d.phase === "done") {
      state.fetchStatus = "done";
      updateLoadButton();
      render();
      setStatus(
        "Done. " + liveReels().length + " reels" +
          (d.reachedOld ? " (stopped at ~2 months old)." : ".")
      );
    } else if (d.phase === "stopped") {
      state.fetchStatus = "idle";
      updateLoadButton();
      render();
      setStatus("Stopped at " + liveReels().length + " reels.");
    } else if (d.phase === "error") {
      state.fetchStatus = "error";
      updateLoadButton();
      setStatus(
        d.reason === "no-user"
          ? "Couldn't identify this profile. Open the profile page, then retry."
          : /^http-/.test(d.reason || "")
          ? "Instagram refused the request (" + d.reason + "). Wait a bit and retry."
          : "Couldn't load automatically. Reload the page and retry."
      );
    }
  });

  function togglePanel() {
    if (!uiReady) buildUI();
    if (!panel) return;
    state.open = !state.open;
    panel.classList.toggle("igrf-hidden", !state.open);
    if (state.open) {
      render();
      maybeAutoLoad();
    }
  }

  // Auto-load this profile's reels the first time the panel is opened, so
  // hashtags appear without the user having to click "Load all reels".
  function maybeAutoLoad() {
    const profile = profileKey();
    if (profile === "__global__") return;
    if (autoStartedProfile === profile) return;
    if (state.fetchStatus === "running") return;
    autoStartedProfile = profile;
    onLoadClick();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "IGRF_TOGGLE") {
      togglePanel();
      sendResponse({ ok: true, open: state.open });
    }
    return true;
  });

  // --- Rendering ------------------------------------------------------------
  function render() {
    if (!els) return;
    const all = liveReels();
    els.count.textContent = all.length + " reels";

    const groups = window.IGRF.buildGroups(all)
      .filter((g) => g.type === "hashtag")
      .slice(0, 80);
    renderGroups(groups, all.length);
    renderResults(filterReels(all), all.length);
  }

  function renderGroups(groups, total) {
    els.groups.innerHTML = "";

    if (groups.length === 0 && !state.activeTerm) {
      const hint = document.createElement("div");
      hint.className = "igrf-group-empty";
      hint.textContent =
        total === 0
          ? "Loading reels..."
          : "No hashtags found in these captions.";
      els.groups.appendChild(hint);
      return;
    }

    if (state.activeTerm) {
      const clear = chip("All", null, false);
      clear.classList.add("igrf-chip-clear");
      clear.addEventListener("click", () => {
        state.activeTerm = null;
        render();
      });
      els.groups.appendChild(clear);
    }
    for (const g of groups) {
      const active =
        state.activeTerm &&
        state.activeTerm.term === g.term &&
        state.activeTerm.type === g.type;
      const label = (g.type === "hashtag" ? "#" : "") + g.term;
      const c = chip(label + " " + g.count, g, active);
      c.addEventListener("click", () => {
        state.activeTerm = active ? null : { term: g.term, type: g.type };
        render();
      });
      els.groups.appendChild(c);
    }
  }

  function chip(text, group, active) {
    const el = document.createElement("button");
    el.className = "igrf-chip" + (active ? " igrf-chip-active" : "");
    if (group && group.type === "hashtag") el.classList.add("igrf-chip-hashtag");
    el.textContent = text;
    return el;
  }

  function filterReels(all) {
    let list = all;
    if (state.activeTerm) {
      const { term, type } = state.activeTerm;
      list = list.filter((r) =>
        type === "hashtag" ? r.hashtags.includes(term) : r.keywords.includes(term)
      );
    }
    if (state.query) {
      const q = state.query;
      list = list.filter(
        (r) =>
          r.caption.toLowerCase().includes(q) ||
          r.hashtags.some((h) => h.includes(q)) ||
          r.keywords.some((k) => k.includes(q))
      );
    }
    if (state.sort === "views") {
      list = [...list].sort((a, b) => (b.views || 0) - (a.views || 0));
    }
    return list;
  }

  function renderResults(list, total) {
    els.results.innerHTML = "";
    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "igrf-empty";
      empty.textContent =
        total === 0
          ? "No reels yet. Click \"Load all reels\" to fetch them."
          : "No reels match this filter.";
      els.results.appendChild(empty);
      return;
    }
    for (const r of list) {
      els.results.appendChild(reelCard(r));
    }
  }

  function reelCard(r) {
    const a = document.createElement("a");
    a.className = "igrf-card";
    a.href = r.url;
    a.target = "_blank";
    a.rel = "noopener";

    const thumb = document.createElement("div");
    thumb.className = "igrf-thumb";
    if (r.thumbnail) {
      const img = document.createElement("img");
      img.src = r.thumbnail;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      thumb.appendChild(img);
    }

    const body = document.createElement("div");
    body.className = "igrf-card-body";

    const cap = document.createElement("div");
    cap.className = "igrf-caption";
    cap.textContent = r.caption || "(no caption)";

    const meta = document.createElement("div");
    meta.className = "igrf-meta";
    const parts = [];
    if (r.views != null) parts.push(formatCount(r.views) + " views");
    if (r.takenAt) parts.push(relativeDate(r.takenAt));
    meta.textContent = parts.join("  ·  ");

    body.appendChild(cap);
    body.appendChild(meta);
    a.appendChild(thumb);
    a.appendChild(body);
    return a;
  }

  function formatCount(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  function relativeDate(takenAtSec) {
    const days = Math.floor((Date.now() / 1000 - takenAtSec) / 86400);
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 7) return days + "d ago";
    if (days < 30) return Math.floor(days / 7) + "w ago";
    return Math.floor(days / 30) + "mo ago";
  }

  // --- Boot -----------------------------------------------------------------
  function boot() {
    buildUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Instagram is an SPA — re-attach the FAB if the DOM is replaced.
  const domObserver = new MutationObserver(() => {
    if (!document.getElementById("igrf-fab") && document.body) {
      uiReady = false;
      fab = null;
      panel = null;
      els = null;
      buildUI();
    }
  });
  domObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
