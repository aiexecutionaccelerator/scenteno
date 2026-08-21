const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (iso) => iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
const cls = (st = "") => st.startsWith("ERR") ? "err" : st.startsWith("skip") ? "skip" : st.startsWith("DRY") ? "warn" : "ok";
const isDone = (st = "") => st === "commented+pinned" || st === "pinned existing";
const itemUrl = (id, kind) => kind === "shorts" ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/post/${id}`;

// Runs inside the extension (chrome.storage) or served by the Railway server (/api/data).
const IN_EXTENSION = typeof chrome !== "undefined" && !!chrome.storage?.local;
async function loadData(keys) {
  if (IN_EXTENSION) return chrome.storage.local.get(keys);
  const r = await fetch("/api/data", { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const openUrl = (url) => IN_EXTENSION ? chrome.tabs.create({ url }) : window.open(url, "_blank");
if (!IN_EXTENSION) {
  document.querySelectorAll("button[data-kind], #dry, label[for=dry]").forEach((el) => (el.closest("label") || el).remove());
  $("#clearFail").remove();
}

// ---------- header actions ----------
document.querySelectorAll("button[data-kind]").forEach((b) =>
  b.addEventListener("click", () =>
    chrome.runtime.sendMessage({ target: "bg", cmd: "run", kind: b.dataset.kind, dryRun: $("#dry").checked })));

$("#export").addEventListener("click", async () => {
  const data = await loadData(["state", "runs", "failures"]);
  for (const f of data.failures || []) { delete f.screenshot; delete f.html; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `scenteno-commenter-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
});

$("#clearFail")?.addEventListener("click", async () => {
  if (confirm("Clear all saved failures?")) await chrome.storage.local.remove("failures");
});

// ---------- comment text editor ----------
const DEFAULT_COMMENTS = {
  bos: "https://scenteno.com/yt12  Join the Brotherhood of Scent to get fragrance advice from a supportive community — and share advice, opinions, and experience with fragrance brothers.",
  hod: "https://www.realmenrealstyle.com/best-frags  Ready to upgrade your fragrance game? Check out House of Dastan here.",
  hodKeyword: "house of dastan",
};
async function loadComments() {
  if (IN_EXTENSION) return (await chrome.storage.local.get("comments")).comments;
  const r = await fetch("/api/comments", { cache: "no-store" }); return r.ok ? r.json() : null;
}
async function showComments() {
  const c = { ...DEFAULT_COMMENTS, ...((await loadComments()) || {}) };
  $("#cBos").value = c.bos; $("#cHod").value = c.hod; $("#cKw").value = c.hodKeyword;
  $("#commentsStatus").textContent = IN_EXTENSION
    ? "Applies to this browser only. If a Railway server is configured, its text takes precedence."
    : "Applies to every browser reporting to this server, from its next run.";
}
$("#saveComments").addEventListener("click", async () => {
  const value = { bos: $("#cBos").value.trim(), hod: $("#cHod").value.trim(), hodKeyword: $("#cKw").value.trim().toLowerCase() };
  if (!value.bos || !value.hod) return ($("#commentsStatus").textContent = "Both comments are required.");
  if (IN_EXTENSION) await chrome.storage.local.set({ comments: value });
  else {
    const r = await fetch("/api/comments", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    if (!r.ok) return ($("#commentsStatus").textContent = "Save failed: HTTP " + r.status);
  }
  $("#commentsStatus").textContent = "Saved " + new Date().toLocaleTimeString();
});
showComments();

["#runKind", "#q", "#itemKind", "#itemStatus"].forEach((s) => $(s).addEventListener("input", render));

// ---------- render ----------
async function render() {
  const { state = {}, runs = [], failures = [], progress } = await loadData(["state", "runs", "failures", "progress"]);
  const items = Object.entries(state).map(([id, v]) => ({ id, ...v }));

  // tiles
  const count = (pred) => items.filter(pred).length;
  const lastRun = (kind) => runs.find((r) => r.kind === kind && !r.dryRun);
  const tiles = [
    [count((i) => isDone(i.status)), "commented + pinned"],
    [count((i) => i.status === "already pinned"), "already pinned (left alone)"],
    [count((i) => i.status === "promo"), "promo posts skipped"],
    [count((i) => i.status?.startsWith("ERR")), "items in error", "err"],
    [runs.length, "runs recorded"],
    [fmt(lastRun("shorts")?.endedAt), "last Shorts run", "", true],
    [fmt(lastRun("posts")?.endedAt), "last Posts run", "", true],
  ];
  $("#tiles").innerHTML = tiles.map(([n, l, c = "", small]) =>
    `<div class="tile"><div class="n ${c}" ${small ? 'style="font-size:15px"' : ""}>${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join("");

  // status line: in-progress or next alarms
  if (progress?.stage === "working") {
    $("#next").textContent = `Running ${progress.kind}: ${progress.index}/${progress.total} — ${progress.current}`;
  } else if (!IN_EXTENSION) {
    const srcs = [...new Set(runs.map((r) => r.source).filter(Boolean))];
    $("#next").textContent = srcs.length ? "Reporting browsers: " + srcs.join(", ") : "No reports received yet";
  } else {
    const alarms = await chrome.alarms.getAll();
    $("#next").textContent = alarms.length
      ? "Next: " + alarms.map((a) => `${a.name} ${new Date(a.scheduledTime).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`).join(" · ")
      : "No schedule set";
  }

  // 30-day activity strip
  const days = [...Array(30)].map((_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (29 - i)); return d; });
  const perDay = days.map((d) => {
    const next = new Date(d); next.setDate(d.getDate() + 1);
    const rs = runs.filter((r) => !r.dryRun && new Date(r.endedAt) >= d && new Date(r.endedAt) < next);
    const flat = rs.flatMap((r) => r.results);
    return { d, ok: flat.filter((x) => isDone(x.status)).length, err: flat.filter((x) => x.status.startsWith("ERR")).length + rs.filter((r) => r.fatal).length };
  });
  const max = Math.max(1, ...perDay.map((p) => p.ok + p.err));
  $("#strip").innerHTML = perDay.map((p) =>
    `<div class="day" title="${p.d.toLocaleDateString()}: ${p.ok} done, ${p.err} errors">
       ${p.err ? `<div class="bar err" style="height:${(p.err / max) * 50}px"></div>` : ""}
       ${p.ok ? `<div class="bar ok" style="height:${(p.ok / max) * 50}px"></div>` : ""}
       ${!p.ok && !p.err ? `<div class="bar" style="background:var(--line)"></div>` : ""}
     </div>`).join("");

  // runs table
  const rk = $("#runKind").value;
  const runRows = runs.filter((r) => !rk || r.kind === rk).slice(0, 100).map((r) => {
    const done = r.results.filter((x) => isDone(x.status)).length;
    const skipped = r.results.filter((x) => x.status.startsWith("skip") || x.status === "already pinned" || x.status === "promo").length;
    const errs = r.results.filter((x) => x.status.startsWith("ERR")).length;
    const dur = Math.round((new Date(r.endedAt) - new Date(r.startedAt)) / 1000);
    const outcome = r.fatal ? `<span class="err">${esc(r.fatal)}</span>` : errs ? `<span class="warn">completed with errors</span>` : `<span class="ok">ok</span>`;
    return `<tr><td>${fmt(r.endedAt)}</td><td class="kind">${r.kind}</td><td>${r.trigger || "manual"}${r.dryRun ? ' <span class="pill warn">dry</span>' : ""}${r.source ? ` <small class="skip">${esc(r.source)}</small>` : ""}</td>
      <td>${r.results.length}</td><td class="ok">${done}</td><td class="skip">${skipped}</td><td class="${errs ? "err" : ""}">${errs}</td>
      <td>${dur >= 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`}</td><td>${outcome}</td></tr>`;
  });
  $("#runs").innerHTML = runRows.join("") || `<tr><td colspan="9" class="empty">No runs yet — click Run Shorts / Run Posts, or wait for the schedule.</td></tr>`;

  // items table
  const statuses = [...new Set(items.map((i) => i.status))].sort();
  const sel = $("#itemStatus"); const cur = sel.value;
  sel.innerHTML = `<option value="">any status</option>` + statuses.map((s) => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("");
  const q = $("#q").value.toLowerCase(), ik = $("#itemKind").value, ist = sel.value;
  const rows = items
    .filter((i) => (!ik || i.kind === ik) && (!ist || i.status === ist) && (!q || i.id.toLowerCase().includes(q) || i.status.toLowerCase().includes(q)))
    .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""))
    .map((i) => `<tr><td class="mono">${esc(i.id)}</td><td class="kind">${esc(i.kind)}</td><td class="${cls(i.status)}">${esc(i.status)}</td><td>${fmt(i.ts)}</td>
      <td><a href="${itemUrl(i.id, i.kind)}" target="_blank">open ↗</a></td></tr>`);
  $("#items").innerHTML = rows.join("") || `<tr><td colspan="5" class="empty">Nothing tracked yet.</td></tr>`;

  // failures
  $("#failures").innerHTML = failures.map((f, i) => `
    <div class="fail">
      ${f.screenshot ? `<img src="${f.screenshot}" data-i="${i}" alt="screenshot">` : ""}
      <div class="meta"><b class="mono">${esc(f.id)}</b> <small>${fmt(f.ts)}</small><br>${esc(f.error)}<br>
        ${f.html || f.hasHtml ? `<a href="#" data-html="${i}">open saved HTML</a>` : ""}</div>
    </div>`).join("") || `<div class="empty">No failures recorded.</div>`;
  $("#failures").querySelectorAll("img").forEach((img) => img.addEventListener("click", () => openUrl(failures[img.dataset.i].screenshot)));
  $("#failures").querySelectorAll("a[data-html]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const f = failures[a.dataset.html];
    openUrl(f.html ? URL.createObjectURL(new Blob([f.html], { type: "text/html" })) : `/api/failures/${f.failureId}/html`);
  }));
}

render();
if (IN_EXTENSION) chrome.storage.onChanged.addListener(render);
setInterval(render, IN_EXTENSION ? 30000 : 60000);
