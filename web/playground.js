// Playground: remember facts, observe events, recall, and inspect every verdict. State lives in IndexedDB ("laya-memory-playground").
import { $, esc, M, initModelCard, onModelsReady, loadRecorded, brain, download, settings, yieldToBrowser } from "./common.js";
import { openStore } from "./store.js";
import { LayaMemory, NeedModelsError } from "./memory.js";
import { attachTracker } from "./tracker.js";
import { renderReport, renderMemories, renderReview, renderEvents, renderLedger, renderRecall, wireActions } from "./views.js";

const store = openStore("laya-memory-playground");
const mem = new LayaMemory(store, brain, { mode: settings.get("mode", "eager") });
window.__lm = { mem, M };
let scenario = null, lastReport = null, demoStep = 0, busy = false;

async function refresh() {
  const [mems, events, ledger] = await Promise.all([mem.memories(), mem.events(), mem.ledger()]);
  $("tab-memories").innerHTML = renderMemories(mems);
  $("tab-review").innerHTML = renderReview(mems, ledger, events);
  $("tab-events").innerHTML = renderEvents(events);
  $("tab-ledger").innerHTML = renderLedger(ledger, mems, events);
  $("cMem").textContent = mems.filter((m) => m.status !== "deleted").length;
  const nrev = mems.filter((m) => m.status === "needs_review").length;
  $("cRev").textContent = nrev || ""; $("cRev").classList.toggle("hot", nrev > 0);
  $("cEv").textContent = events.length; $("cLed").textContent = ledger.length;
  $("report").innerHTML = lastReport ? renderReport(lastReport, mem.policy) : $("report").innerHTML;
  const pending = events.filter((e) => e.pending).length;
  $("storeInfo").textContent = `${(await store.persistent()) ? "Saved in IndexedDB" : "IndexedDB unavailable: kept in memory for this tab"} · ${mems.length} facts, ${events.length} events (${pending} pending), ${ledger.length} ledger rows · ${brain.live() ? "Laya calls" : "answers replayed from the recording"} ${mem.stats.layaCalls}, answers reused from the cache ${mem.stats.cached}.`;
}

async function guarded(fn) {
  if (busy) return;
  busy = true; document.body.classList.add("busy");
  try { await fn(); } catch (e) {
    console.error(e);
    $("report").innerHTML = `<p class="status warn">${esc(e instanceof NeedModelsError ? e.message + " Pick one of the example chips, or load the models above." : e.message)}</p>`;
  } finally { busy = false; document.body.classList.remove("busy"); await refresh(); }
}

async function observe(text, source) {
  $("report").innerHTML = `<p class="placeholder">Checking “${esc(text)}”…</p>`;
  const { report } = await mem.observe(text, { source, type: "message", dryRun: $("dry").checked, rememberSuccessor: $("succ").checked });
  if (report) lastReport = report;
  else $("report").innerHTML = `<p class="placeholder">Lazy mode: “${esc(text)}” is logged as pending. It is checked when a recall would return a similar fact, or on Sweep.</p>`;
}

// ---------- demo ----------
const demoEvents = () => scenario.playground.events;
function demoLabel() {
  const n = demoEvents().length;
  $("demoState").textContent = demoStep === 0 ? "" : demoStep > n ? "Demo done. Try a recall, or open the Review queue and Ledger tabs." : `Next: event ${demoStep} of ${n}.`;
  $("stepBtn").textContent = demoStep === 0 ? "One step" : demoStep > n ? "Restart" : `Step ${demoStep} of ${n}`;
}
async function demoNext() {
  if (demoStep === 0 || demoStep > demoEvents().length) {
    await store.clear(); lastReport = null;
    for (const f of scenario.playground.memories) await mem.remember(f.text, { source: f.source, kind: f.kind });
    demoStep = 1;
    $("report").innerHTML = `<p class="placeholder">Stored ${scenario.playground.memories.length} facts. Next, the events arrive one at a time.</p>`;
    return;
  }
  const e = demoEvents()[demoStep - 1];
  $("evText").value = e.text; $("evSource").value = e.source;
  await observe(e.text, e.source);
  demoStep++;
}

function chips(el, items, onPick) {
  el.innerHTML = items.map((t, i) => `<button type="button" data-i="${i}" title="${esc(t.text || t)}" data-track="chip">${esc((t.text || t).slice(0, 44))}${(t.text || t).length > 44 ? "…" : ""}</button>`).join("");
  el.addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (b) onPick(items[+b.dataset.i]); });
}

async function main() {
  attachTracker(mem);
  initModelCard();
  scenario = await (await fetch("./scenarios.json")).json();
  await loadRecorded();
  const fixed = await mem.recover();
  if (fixed) console.info(`recovered ${fixed} half-applied ledger rows`);
  document.querySelector(`input[name=mode][value=${mem.mode}]`).checked = true;

  chips($("eventChips"), demoEvents(), (e) => { $("evText").value = e.text; $("evSource").value = e.source; });
  chips($("queryChips"), scenario.playground.queries, (q) => { $("query").value = q; });

  $("demoBtn").addEventListener("click", () => guarded(async () => {
    demoStep = 0;
    for (let i = 0; i <= demoEvents().length; i++) { await demoNext(); demoLabel(); await refresh(); await yieldToBrowser(); }
  }).then(demoLabel));
  $("stepBtn").addEventListener("click", () => guarded(demoNext).then(demoLabel));
  $("rememberBtn").addEventListener("click", () => guarded(async () => {
    const t = $("memText").value.trim(); if (!t) return;
    await mem.remember(t, { source: $("memSource").value, kind: $("memKind").value, ttl: Number($("memTtl").value) || null });
    $("memText").value = "";
  }));
  $("observeBtn").addEventListener("click", () => guarded(async () => { const t = $("evText").value.trim(); if (t) await observe(t, $("evSource").value); }));
  $("recallBtn").addEventListener("click", () => guarded(async () => {
    const q = $("query").value.trim(); if (!q) return;
    const r = await mem.recall(q, { includeReview: $("incReview").checked });
    $("recallOut").innerHTML = renderRecall(r);
    if (r.lazyReports.length) lastReport = r.lazyReports.at(-1);
  }));
  for (const r of document.querySelectorAll("input[name=mode]")) r.addEventListener("change", () => { mem.mode = r.value; settings.set("mode", r.value); refresh(); });
  $("sweepBtn").addEventListener("click", () => guarded(async () => {
    const r = await mem.sweep();
    if (r.reports.length) lastReport = r.reports.at(-1);
    $("storeInfo").textContent = `Sweep: ${r.expired} expired, ${r.reports.length} pending events checked.`;
  }));
  $("exportBtn").addEventListener("click", async () => download(`laya-memory-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await mem.exportAll(), null, 1)));
  $("importFile").addEventListener("change", (e) => guarded(async () => {
    const f = e.target.files[0]; if (!f) return;
    await mem.importAll(JSON.parse(await f.text())); e.target.value = "";
  }));
  $("clearBtn").addEventListener("click", () => guarded(async () => {
    if (!confirm("Delete all memories, events and the ledger in this browser?")) return;
    await store.clear(); lastReport = null; demoStep = 0; demoLabel();
    $("report").innerHTML = `<p class="placeholder">Cleared.</p>`;
  }));

  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => {
    for (const x of document.querySelectorAll(".tabs button")) x.setAttribute("aria-selected", String(x === b));
    for (const p of document.querySelectorAll(".tabcard .panel")) p.hidden = p.id !== "tab-" + b.dataset.tab;
  });
  wireActions($("tab-memories"), mem, refresh);
  wireActions($("tab-review"), mem, refresh);
  mem.on((type) => { if (type === "event" && !busy) refresh(); });
  onModelsReady(refresh);
  demoLabel();
  await refresh();
}
main();
