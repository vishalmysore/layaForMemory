// HTML for the memory engine's state, shared by the playground and the user-actions page.
import { esc, pct, num, ago, statusChip, verdictChip, bars, voteBars } from "./common.js";

const LIVE = new Set(["active", "needs_review", "frozen"]);

/** One observed event and what it did. */
export function renderReport(r, policy) {
  if (!r) return `<p class="placeholder">Nothing checked yet.</p>`;
  const kindSel = Object.entries(r.kind.kind).sort((a, b) => b[1] - a[1])[0][0];
  const head = `<div class="evhead"><div class="evtext">“${esc(r.event.text)}”</div><div class="evmeta"><span class="tag">${esc(r.event.source)}</span>${r.dryRun ? `<span class="tag warn">dry run</span>` : ""}<span class="tag">${r.ms ? `${(r.ms / 1000).toFixed(1)} s of model time` : "from recorded/cached answers"}</span></div></div>`;
  const kind = `<div class="step"><h3>1 · What kind of message is it?</h3>${bars(r.kind.kind, kindSel)}
    <p class="hint">Command ${num(r.kind.command)} (≥ ${policy.command} → logged only) · question + proposal ${num(r.kind.hypothetical)} (≥ ${policy.hypothetical} → logged only)</p></div>`;
  if (r.verdict) {
    return head + kind + `<div class="outcomebox vd-bg-${r.verdict}">${verdictChip(r.verdict)} <span>${esc(r.reason)}. No memory was checked or changed.</span></div>`;
  }
  const checks = r.checks.length
    ? r.checks.map((c) => `<div class="check-row">
        <div class="ch-mem"><div class="ch-text">${esc(c.memory.text)}</div><div class="ch-meta"><span class="tag">${esc(c.memory.source)}</span><span class="tag">similarity ${num(c.sim)}</span>${c.cached ? `<span class="tag">cached</span>` : ""}</div></div>
        <div class="ch-votes">${voteBars(c.votes, policy)}</div>
        <div class="ch-verdict">${verdictChip(c.verdict)}<div class="ch-reason">${esc(c.reason)}</div>${c.from !== c.to ? `<div class="ch-move">${esc(c.from)} → <b>${esc(c.to)}</b></div>` : `<div class="ch-move muted">${r.dryRun ? "dry run: unchanged" : "unchanged"}</div>`}</div>
      </div>`).join("")
    : `<p class="hint">No stored fact is similar enough (cosine ≥ ${policy.minSim}) to be checked.</p>`;
  const succ = r.successor ? `<div class="outcomebox vd-bg-superseded">New fact stored verbatim as the successor: “${esc(r.successor.text)}”</div>` : "";
  return head + kind + `<div class="step"><h3>2 · Is each similar fact still true? <span class="meta">stale score: ≤ ${policy.keep} stands · ≥ ${policy.stale} out of date (needs ${policy.agree}/4 votes) · in between: review</span></h3>${checks}</div>` + succ;
}

/** Memory list. Superseded/contradicted facts stay visible, struck through, with their successor. */
export function renderMemories(mems, { showClosed = true } = {}) {
  if (!mems.length) return `<p class="placeholder">No memories yet.</p>`;
  const byId = new Map(mems.map((m) => [m.id, m]));
  const order = { active: 0, needs_review: 1, frozen: 2, superseded: 3, contradicted: 4, expired: 5, deleted: 6 };
  const list = mems.filter((m) => showClosed || LIVE.has(m.status)).sort((a, b) => order[a.status] - order[b.status] || b.createdAt - a.createdAt);
  return `<ul class="memlist">${list.map((m) => {
    const succ = m.successorId && byId.get(m.successorId);
    const pred = m.predecessorId && byId.get(m.predecessorId);
    const acts = [
      m.status === "frozen" ? ["unfreeze", "Unfreeze"] : LIVE.has(m.status) ? ["freeze", "Freeze"] : null,
      ["superseded", "contradicted", "expired", "deleted"].includes(m.status) ? ["restore", "Restore"] : null,
      m.status === "needs_review" ? ["keep", "Still true"] : null,
      m.status !== "deleted" ? ["forget", "Forget"] : null,
    ].filter(Boolean);
    return `<li class="mem mem-${m.status}" id="mem-${m.id}">
      <div class="mtop">${statusChip(m.status)}<span class="mtext">${esc(m.text)}</span></div>
      <div class="mmeta"><span class="tag">${esc(m.source)}</span><span class="tag">${esc(m.kind)}</span><span class="belief" title="belief that it still holds"><span class="pbar"><i style="width:${pct(m.pTrue ?? 1)}"></i></span>${num(m.pTrue ?? 1)}</span><span class="muted">${ago(m.createdAt)}</span>${m.ttl ? `<span class="tag">lease ${m.ttl}s</span>` : ""}
        ${succ ? `<span class="link">→ replaced by “${esc(succ.text)}”</span>` : ""}${pred ? `<span class="link">← replaces “${esc(pred.text)}”</span>` : ""}</div>
      <div class="macts">${acts.map(([a, t]) => `<button class="mini" data-act="${a}" data-id="${m.id}" data-track="mem-${a}">${t}</button>`).join("")}</div>
    </li>`;
  }).join("")}</ul>`;
}

/** Review queue: each needs_review fact with the event that put it there, and the two ways out. */
export function renderReview(mems, ledger, events) {
  const rev = mems.filter((m) => m.status === "needs_review");
  if (!rev.length) return `<p class="placeholder">Nothing to review. When Laya is unsure, the fact lands here instead of being changed.</p>`;
  const evById = new Map(events.map((e) => [e.id, e]));
  return `<ul class="memlist">${rev.map((m) => {
    const why = [...ledger].reverse().find((l) => l.memoryId === m.id && l.verdict === "needs_review");
    const ev = why && evById.get(why.eventId);
    return `<li class="mem mem-needs_review">
      <div class="mtop">${statusChip(m.status)}<span class="mtext">${esc(m.text)}</span></div>
      ${ev ? `<div class="mmeta">because of “${esc(ev.text)}” <span class="tag">${esc(ev.source)}</span></div><div class="hint">${esc(why.reason)}</div>` : ""}
      <div class="macts"><button class="mini" data-act="keep" data-id="${m.id}" data-track="review-keep">Still true</button>${ev ? `<button class="mini" data-act="stale" data-id="${m.id}" data-event="${ev.id}" data-track="review-stale">Out of date: replace with the event</button>` : ""}<button class="mini" data-act="forget" data-id="${m.id}" data-track="review-forget">Forget</button></div>
    </li>`;
  }).join("")}</ul>`;
}

/** Every action stored in IndexedDB: observed events with text, and raw UI actions. */
export function renderEvents(events, { limit = 200 } = {}) {
  if (!events.length) return `<p class="placeholder">No events yet.</p>`;
  const rows = [...events].reverse().slice(0, limit);
  return `<div class="tablewrap"><table class="grid evtable"><thead><tr><th>When</th><th>Type</th><th>Source</th><th>Event</th><th>State</th></tr></thead><tbody>${rows.map((e) => `<tr class="${e.observe ? "obs" : "raw"}">
    <td class="muted">${ago(e.ts)}</td><td>${esc(e.type)}</td><td>${esc(e.source)}</td>
    <td>${e.text ? `“${esc(e.text)}”` : `<code>${esc(JSON.stringify(e.detail))}</code>`}</td>
    <td>${!e.observe ? `<span class="muted">logged</span>` : e.pending ? `<span class="tag warn">pending</span>` : `<span class="tag ok">checked</span>`}</td></tr>`).join("")}</tbody></table></div>
    ${events.length > limit ? `<p class="hint">Showing the latest ${limit} of ${events.length}.</p>` : ""}`;
}

/** The audit trail, newest first. */
export function renderLedger(ledger, mems, events) {
  if (!ledger.length) return `<p class="placeholder">The ledger is empty.</p>`;
  const mById = new Map(mems.map((m) => [m.id, m])), eById = new Map(events.map((e) => [e.id, e]));
  return `<div class="tablewrap"><table class="grid"><thead><tr><th>When</th><th>Who</th><th>Verdict</th><th>Fact</th><th>Event</th><th>Status</th><th>Why</th></tr></thead><tbody>${[...ledger].reverse().map((l) => {
    const m = mById.get(l.memoryId), e = eById.get(l.eventId);
    return `<tr><td class="muted">${ago(l.ts)}</td><td>${esc(l.actor)}</td><td>${verdictChip(l.verdict)}</td>
      <td>${m ? esc(m.text) : `<span class="muted">–</span>`}</td><td>${e ? `“${esc(e.text)}”` : `<span class="muted">–</span>`}</td>
      <td>${l.from && l.to && l.from !== l.to ? `${esc(l.from)} → <b>${esc(l.to)}</b>` : l.to ? esc(l.to) : "–"}${l.applied ? "" : ` <span class="tag bad">not applied</span>`}${l.recovered ? ` <span class="tag">recovered</span>` : ""}</td>
      <td class="why">${esc(l.reason || "")}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

/** Recall results. */
export function renderRecall(r) {
  const lazy = r.lazyReports?.length ? `<p class="hint">Lazy mode: checked ${r.lazyReports.length} pending event${r.lazyReports.length > 1 ? "s" : ""} against these facts first.</p>` : "";
  if (!r.hits.length) return lazy + `<p class="hint">Nothing live matches.</p>`;
  return lazy + `<ol class="recall">${r.hits.map((h) => `<li>${statusChip(h.m.status)} ${esc(h.m.text)} <span class="muted">· similarity ${num(h.sim)} × belief ${num(h.m.pTrue ?? 1)} = ${num(h.score)}</span></li>`).join("")}</ol>`;
}

/** Buttons with data-act inside `root` call mem.act(). */
export function wireActions(root, mem, after) {
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    b.disabled = true;
    try { await mem.act(b.dataset.id, b.dataset.act, { eventId: b.dataset.event || null }); } catch (err) { alert(err.message); }
    await after();
  });
}
