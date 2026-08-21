const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cls = (st) => st.startsWith("ERR") ? "err" : st.startsWith("skip") ? "skip" : "ok";

document.querySelectorAll("button[data-kind]").forEach((b) =>
  b.addEventListener("click", () =>
    chrome.runtime.sendMessage({ target: "bg", cmd: "run", kind: b.dataset.kind, dryRun: $("#dry").checked })));

$("#dash").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") }));

$("#clear").addEventListener("click", async () => {
  if (confirm("Forget all done items? Next run will re-check everything (it still never double-posts).")) {
    await chrome.storage.local.remove(["state", "failures"]);
    render();
  }
});

chrome.storage.local.get("settings").then(({ settings = {} }) => {
  $("#serverUrl").value = settings.serverUrl || "";
  $("#token").value = settings.token || "";
  if (settings.serverUrl) $("#settings").open = false;
});
$("#saveSettings").addEventListener("click", async () => {
  await chrome.storage.local.set({ settings: { serverUrl: $("#serverUrl").value.trim(), token: $("#token").value.trim() } });
  $("#reportStatus").textContent = "saved — reports are sent after each run";
});

function table(results) {
  return "<table>" + results.map((r) =>
    `<tr><td title="${esc(r.id)}">${esc(r.id)}</td><td class="${cls(r.status)}">${esc(r.status)}</td></tr>`).join("") + "</table>";
}

async function render() {
  const { progress, runs = [], failures = [], pending = [], lastReportError } = await chrome.storage.local.get(["progress", "runs", "failures", "pending", "lastReportError"]);
  if (lastReportError) $("#reportStatus").textContent = `⚠ ${pending.length} report(s) queued — last error: ${lastReportError}`;
  const reports = {};
  for (const r of runs) if (!reports[r.kind]) reports[r.kind] = { ts: r.endedAt, dryRun: r.dryRun, results: r.results };
  const p = progress;
  $("#progress").textContent = !p ? "idle"
    : p.stage === "working" ? `${p.kind}: ${p.index}/${p.total}  ${p.current}`
    : p.stage === "done" ? `${p.kind}: done — ${p.errors} error(s)  (${new Date(p.ts).toLocaleString()})`
    : p.stage === "error" ? `${p.kind}: ERROR — ${p.message}`
    : `${p.kind}: ${p.stage}`;

  $("#reports").innerHTML = Object.entries(reports).map(([kind, r]) =>
    `<details open><summary><b>${kind}</b> — ${new Date(r.ts).toLocaleString()}${r.dryRun ? " (dry run)" : ""}</summary>${table(r.results)}</details>`).join("");

  $("#failCount").textContent = failures.length;
  $("#failures").innerHTML = failures.map((f, i) =>
    `<div class="fail"><b>${esc(f.id)}</b> <small>${new Date(f.ts).toLocaleString()}</small><br>${esc(f.error)}<br>
     ${f.screenshot ? `<a href="#" data-shot="${i}">screenshot</a>` : ""} ${f.html ? `<a href="#" data-html="${i}">html</a>` : ""}</div>`).join("");
  $("#failures").querySelectorAll("a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const f = failures[a.dataset.shot ?? a.dataset.html];
    const url = a.dataset.shot != null ? f.screenshot : URL.createObjectURL(new Blob([f.html], { type: "text/html" }));
    chrome.tabs.create({ url });
  }));
}

render();
chrome.storage.onChanged.addListener(render);
