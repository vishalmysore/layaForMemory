// Evaluation: score the policy on the labeled cases from stored Laya answers; re-score instantly when sliders move.
import { $, esc, M, initModelCard, onModelsReady, loadRecorded, num, pct, verdictChip, voteBars, yieldToBrowser, compactAnswers } from "./common.js";
import { QUESTIONS, DEFAULT_POLICY, VERDICTS, STALE, DESTRUCTIVE, eventVotes, pairVotes, decide, eventState, pairState, eventCacheKey, pairCacheKey } from "./governor-core.js";

let cases = [], answers = {}, source = "recorded", policy = { ...DEFAULT_POLICY };
const SLIDERS = [
  ["keep", "Stands at or below", 0.2, 0.7, 0.01],
  ["stale", "Out of date at or above", 0.3, 0.8, 0.01],
  ["agree", "Kill switch: votes that must agree", 0, 4, 1],
  ["command", "Command at or above", 0.2, 0.9, 0.01],
  ["hypothetical", "Question / plan at or above", 0.2, 0.9, 0.01],
  ["replaces", "Superseded if replaces share ≥", 0.2, 0.8, 0.01],
];
const mem = (c) => ({ text: c.memory, source: c.memSource });
const ev = (c) => ({ text: c.event, source: c.evSource });

function judgeCase(c) {
  const ea = answers[eventCacheKey(ev(c))], pa = answers[pairCacheKey(mem(c), ev(c))];
  if (!ea || !pa) return null;
  const k = eventVotes(ea), p = pairVotes(pa);
  return { k, p, ...decide(k, p, policy) };
}
const lenientOk = (e, v) => (STALE.has(e) ? STALE.has(v) : e === "confirmed" || e === "unrelated" ? v === "confirmed" || v === "unrelated" : v === e);

function render() {
  const rows = cases.map((c) => ({ c, r: judgeCase(c) })).filter((x) => x.r);
  const n = rows.length;
  if (!n) { $("kpis").innerHTML = `<p class="placeholder">No stored answers yet. Load the models and press Run.</p>`; return; }
  const strict = rows.filter((x) => x.r.verdict === x.c.expected).length;
  const lenient = rows.filter((x) => lenientOk(x.c.expected, x.r.verdict)).length;
  const falseInv = rows.filter((x) => DESTRUCTIVE.has(x.r.verdict) && !STALE.has(x.c.expected));
  const staleRows = rows.filter((x) => DESTRUCTIVE.has(x.c.expected));
  const caught = staleRows.filter((x) => DESTRUCTIVE.has(x.r.verdict)).length;
  const anyStale = rows.filter((x) => STALE.has(x.c.expected));
  const flagged = anyStale.filter((x) => STALE.has(x.r.verdict)).length;
  const gated = rows.filter((x) => ["hypothetical", "directive"].includes(x.c.expected));
  const gatedOk = gated.filter((x) => x.r.verdict === x.c.expected).length;
  const kpi = (l, v, s = "") => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}${s ? ` <small>${s}</small>` : ""}</div></div>`;
  $("kpis").innerHTML = kpi("Strict accuracy", pct(strict / n, 1), `${strict}/${n}`) + kpi("Lenient accuracy", pct(lenient / n, 1), `${lenient}/${n}`)
    + kpi("False invalidations", falseInv.length, `of ${rows.filter((x) => !STALE.has(x.c.expected)).length} standing`)
    + kpi("Stale facts closed", pct(caught / staleRows.length), `${caught}/${staleRows.length} superseded or contradicted`)
    + kpi("Stale facts flagged", pct(flagged / anyStale.length), `${flagged}/${anyStale.length} incl. review`)
    + kpi("Questions + commands gated", pct(gatedOk / gated.length), `${gatedOk}/${gated.length}`);

  const labels = VERDICTS;
  const cm = Object.fromEntries(labels.map((a) => [a, Object.fromEntries(labels.map((b) => [b, 0]))]));
  for (const x of rows) cm[x.c.expected][x.r.verdict]++;
  $("cm").innerHTML = `<table class="grid cm"><thead><tr><th></th>${labels.map((l) => `<th class="r">${verdictChip(l)}</th>`).join("")}</tr></thead><tbody>${labels.map((a) => `<tr><th>${verdictChip(a)}</th>${labels.map((b) => {
    const v = cm[a][b];
    const cls = !v ? "" : a === b ? "hit" : DESTRUCTIVE.has(b) && !STALE.has(a) ? "bad" : "";
    return `<td class="r ${cls}">${v || ""}</td>`;
  }).join("")}</tr>`).join("")}</tbody></table>`;

  const f = $("filter").value;
  const shown = rows.filter((x) => f === "all" || (f === "wrong" && x.r.verdict !== x.c.expected) || (f === "false" && falseInv.includes(x)));
  $("cases").innerHTML = `<table class="grid"><thead><tr><th>Memory</th><th>Event</th><th>Label</th><th>Verdict</th><th>Votes</th></tr></thead><tbody>${shown.map(({ c, r }) => {
    const cls = r.verdict === c.expected ? "" : lenientOk(c.expected, r.verdict) ? "lenient" : "wrong";
    return `<tr class="${cls}"><td>${esc(c.memory)}<div class="muted">${esc(c.memSource)}</div></td><td>${esc(c.event)}<div class="muted">${esc(c.evSource)} · command ${num(r.k.command)} · question/plan ${num(r.k.hypothetical)}</div></td>
      <td>${verdictChip(c.expected)}</td><td>${verdictChip(r.verdict)}<div class="ch-reason">${esc(r.reason)}</div></td><td style="min-width:300px">${voteBars(r.p, policy)}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function sliders() {
  $("sliders").innerHTML = SLIDERS.map(([k, l, lo, hi, st]) => `<div class="field"><label for="s-${k}">${l} <output id="o-${k}">${policy[k]}</output></label><input type="range" id="s-${k}" min="${lo}" max="${hi}" step="${st}" value="${policy[k]}"></div>`).join("");
  for (const [k] of SLIDERS) $("s-" + k).addEventListener("input", (e) => { policy[k] = Number(e.target.value); $("o-" + k).textContent = policy[k]; render(); });
}

async function runLive() {
  $("runBtn").disabled = true; $("runProg").hidden = false;
  const fresh = {}; let i = 0; const t0 = performance.now();
  try {
    for (const c of cases) {
      const ek = eventCacheKey(ev(c)), pk = pairCacheKey(mem(c), ev(c));
      if (!fresh[ek]) fresh[ek] = compactAnswers((await M.laya.systemOne(eventState(ev(c)), QUESTIONS.event)).answers);
      fresh[pk] = compactAnswers((await M.laya.systemOne(pairState(mem(c), ev(c)), QUESTIONS.pair)).answers);
      $("runBar").style.width = `${(++i / cases.length) * 100}%`;
      $("runInfo").textContent = `Running: ${i}/${cases.length}…`;
      await yieldToBrowser();
    }
    answers = fresh; source = `${M.model.variant} on ${M.model.backend}, just now`;
    $("runInfo").textContent = `Scored from your run (${source}), ${((performance.now() - t0) / 1000).toFixed(0)} s.`;
    render();
  } finally { $("runBtn").disabled = false; $("runProg").hidden = true; }
}

async function main() {
  initModelCard();
  cases = (await (await fetch("./cases.json")).json()).cases;
  const rec = await loadRecorded();
  answers = rec.answers || {};
  const m = rec.model;
  $("runInfo").textContent = m ? `Showing answers recorded with ${m.variant} on ${m.backend} (${m.recordedAt?.slice(0, 10) || "recorded"}).` : "No recorded answers.";
  sliders();
  $("resetPolicy").addEventListener("click", () => { policy = { ...DEFAULT_POLICY }; sliders(); render(); });
  $("filter").addEventListener("change", render);
  $("runBtn").addEventListener("click", runLive);
  onModelsReady(() => { $("runBtn").disabled = false; });
  window.__lme = { runLive, cases: () => cases, answers: () => answers };
  render();
}
main();
