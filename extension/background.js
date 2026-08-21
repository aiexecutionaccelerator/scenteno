// Scheduler + orchestrator. Opens one worker tab, drives it through the listing and
// each item, records results in chrome.storage.local. Works in Chrome and Firefox (MV3).

const KINDS = {
  shorts: { listing: "https://www.youtube.com/@Scenteno/shorts", part: "/shorts/", scrolls: 15, periodHours: 24 },
  posts:  { listing: "https://www.youtube.com/@Scenteno/posts",  part: "/post/",   scrolls: 20, periodHours: 12 },
};
const LIMIT = 10;
const DONE = new Set(["commented+pinned", "pinned existing", "already pinned", "promo"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- schedule ----------
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
function schedule() {
  for (const [kind, cfg] of Object.entries(KINDS))
    chrome.alarms.create(kind, { delayInMinutes: 5, periodInMinutes: cfg.periodHours * 60 });
}
let currentTrigger = "manual";
chrome.alarms.onAlarm.addListener((a) => { if (KINDS[a.name]) { currentTrigger = "scheduled"; run(a.name, false); } });

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.target !== "bg") return;
  if (msg.cmd === "run") { currentTrigger = "manual"; run(msg.kind, msg.dryRun); sendResponse({ started: true }); }
  return false;
});

// ---------- tab helpers ----------
// Poll tabs.get() instead of waiting on onUpdated: Firefox suspends event pages that are
// only waiting on timers/events, and a same-URL update may never emit "complete".
async function waitForLoad(tabId, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  await sleep(500);
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") { await sleep(500); return; }
    await sleep(300);
  }
  throw new Error("page load timeout");
}
async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["yt.js"] });
}

async function ask(tabId, msg) {
  const r = await chrome.tabs.sendMessage(tabId, { target: "yt", ...msg });
  if (!r) throw new Error("no response from page script");
  if (!r.ok) { const e = new Error(r.error); e.html = r.html; throw e; }
  return r.result;
}

async function isSignedIn(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        if (document.querySelector("#avatar-btn")) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    },
  });
  return result;
}

async function saveFailure(tabId, id, error, html) {
  let screenshot = null;
  try {
    // captureVisibleTab shoots the *active* tab, so briefly bring the worker tab forward
    const { windowId } = await chrome.tabs.update(tabId, { active: true });
    await sleep(300);
    screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 60 });
  } catch {}
  const { failures = [] } = await chrome.storage.local.get("failures");
  failures.unshift({ id, error, ts: new Date().toISOString(), screenshot, html: html || null });
  await chrome.storage.local.set({ failures: failures.slice(0, 10) });
}

// Every run (scheduled or manual) is appended to `runs` (newest first, capped) for the dashboard.
async function recordRun(kind, dryRun, results, startedAt, fatal) {
  const run = { kind, dryRun, startedAt, endedAt: new Date().toISOString(), fatal, results, trigger: currentTrigger };
  const { runs = [] } = await chrome.storage.local.get("runs");
  runs.unshift(run);
  await chrome.storage.local.set({ runs: runs.slice(0, 200) });
  await report(run);
}

// ---------- remote dashboard (optional; Railway server) ----------
// Each run is queued and POSTed to the server with the current item state and any new
// failures. If the server is unreachable the queue persists and is flushed next time.
async function report(run) {
  const { settings = {}, pending = [], state = {}, failures = [] } = await chrome.storage.local.get(["settings", "pending", "state", "failures"]);
  if (!settings.serverUrl || !settings.token) return;
  const newFailures = failures.filter((f) => f.ts >= run.startedAt);
  const queue = [...pending, { runs: [run], state, failures: newFailures }];
  const kept = [];
  for (const payload of queue) {
    try {
      const res = await fetch(settings.serverUrl.replace(/\/$/, "") + "/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.token}` },
        body: JSON.stringify({ source: settings.source || navigator.userAgent.match(/Firefox|Edg|Chrome/)?.[0] || "browser", ...payload }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      kept.push(payload);
      await chrome.storage.local.set({ lastReportError: `${new Date().toISOString()} ${e.message}` });
    }
  }
  await chrome.storage.local.set({ pending: kept.slice(-20), ...(kept.length ? {} : { lastReportError: null }) });
}

// Comment texts: server copy wins (edited on the Railway dashboard), then the local dashboard
// copy, then the defaults baked into yt.js. Cached locally so a server outage changes nothing.
async function loadComments() {
  const { settings = {}, comments = null } = await chrome.storage.local.get(["settings", "comments"]);
  if (settings.serverUrl && settings.token) {
    try {
      const res = await fetch(settings.serverUrl.replace(/\/$/, "") + "/api/config", { headers: { Authorization: `Bearer ${settings.token}` } });
      if (res.ok) {
        const { comments: remote } = await res.json();
        if (remote) { await chrome.storage.local.set({ comments: remote }); return remote; }
      }
    } catch {}
  }
  return comments;
}

async function setProgress(kind, progress) {
  await chrome.storage.local.set({ progress: { kind, ...progress, ts: new Date().toISOString() } });
}

// ---------- main ----------
let running = false;
async function run(kind, dryRun) {
  if (running) return;
  running = true;
  const cfg = KINDS[kind];
  const results = [];
  const startedAt = new Date().toISOString();
  let tab;
  try {
    await setProgress(kind, { stage: "starting" });
    tab = await chrome.tabs.create({ url: "https://www.youtube.com/", active: false });
    await setProgress(kind, { stage: "loading youtube.com" });
    await waitForLoad(tab.id);
    await setProgress(kind, { stage: "checking sign-in" });
    if (!(await isSignedIn(tab.id))) {
      await saveFailure(tab.id, "signin", "Not signed in to YouTube — sign in as @Scenteno in this browser and run again.");
      await recordRun(kind, dryRun, results, startedAt, "Not signed in to YouTube");
      await setProgress(kind, { stage: "error", message: "Not signed in to YouTube" });
      return;
    }

    await setProgress(kind, { stage: "collecting newest items" });
    await navigate(tab.id, cfg.listing);
    await inject(tab.id);
    const urls = await ask(tab.id, { cmd: "collect", part: cfg.part, limit: LIMIT, scrolls: cfg.scrolls });
    if (!urls.length) {
      await saveFailure(tab.id, "listing", "No items found on listing page");
      await recordRun(kind, dryRun, results, startedAt, "Listing page returned no items");
      await setProgress(kind, { stage: "error", message: "Listing page returned no items" });
      return;
    }

    const comments = await loadComments();
    const { state = {} } = await chrome.storage.local.get("state");
    for (const [i, url] of urls.entries()) {
      const id = url.split(cfg.part)[1].replace(/\/$/, "");
      await setProgress(kind, { stage: "working", current: id, index: i + 1, total: urls.length, results });
      const prior = state[id]?.status;
      if (DONE.has(prior)) { results.push({ id, status: `skip (${prior})` }); continue; }

      let status;
      try {
        await navigate(tab.id, url);
        await inject(tab.id);
        ({ status } = await ask(tab.id, { cmd: "process", kind, dryRun, comments }));
      } catch (e) {
        status = `ERR ${e.message}`.slice(0, 120);
        await saveFailure(tab.id, id, e.message, e.html);
      }
      results.push({ id, status });
      if (!dryRun) {
        state[id] = { status, kind, ts: new Date().toISOString() };
        await chrome.storage.local.set({ state });
      }
      await sleep(4000 + Math.random() * 6000); // human-ish pause between items
    }

    const errors = results.filter((r) => r.status.startsWith("ERR")).length;
    await recordRun(kind, dryRun, results, startedAt, null);
    await setProgress(kind, { stage: "done", results, errors });
  } catch (e) {
    if (tab) await saveFailure(tab.id, "run", e.message);
    await recordRun(kind, dryRun, results, startedAt, e.message);
    await setProgress(kind, { stage: "error", message: e.message, results });
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
    running = false;
  }
}
