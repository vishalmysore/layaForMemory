// Shared by all pages: the model card (Laya + the embedding model), the "brain" the memory engine runs on (live
// models, or answers recorded from the same models), and small DOM helpers.
import { loadEmbedder, embedderCached, EMBED_MODEL } from "./embedder.js";
import { NeedModelsError } from "./memory.js";

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const pct = (p, d = 0) => (p == null ? "–" : `${(p * 100).toFixed(d)}%`);
export const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d));
export const ago = (ts) => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(ts).toLocaleDateString(); };
// MessageChannel, not setTimeout: background tabs clamp setTimeout to >= 1 s.
export const yieldToBrowser = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

export const settings = {
  get(k, d) { try { const v = localStorage.getItem("lm." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lm." + k, JSON.stringify(v)); } catch { /* fine */ } },
};

export const M = { laya: null, embedder: null, model: null, manifest: null, loading: false, listeners: [], recorded: null, capture: null };
export const onModelsReady = (fn) => M.listeners.push(fn);
let modelMod = null;
const modelApi = () => (modelMod ||= import("./model.js"));

// ---------- recorded playback ----------
/** int8 + scale, base64: 384-d vector in ~520 characters. */
export function encodeVec(v) {
  let mx = 0; for (const x of v) mx = Math.max(mx, Math.abs(x));
  const s = mx / 127 || 1, b = new Int8Array(v.length);
  v.forEach((x, i) => { b[i] = Math.round(x / s); });
  return `${s.toPrecision(6)}:${btoa(String.fromCharCode(...new Uint8Array(b.buffer)))}`;
}
export function decodeVec(str) {
  const [s, b64] = str.split(":");
  const bytes = Int8Array.from(atob(b64), (c) => (c.charCodeAt(0) << 24) >> 24);
  const v = Float32Array.from(bytes, (x) => x * Number(s));
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
/** Keep only what the engine reads from a Laya answer. */
export const compactAnswers = (answers) => Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.type === "noul" ? { noul: a.noul } : { probabilities: a.probabilities }]));

export async function loadRecorded() {
  if (M.recorded) return M.recorded;
  try { const r = await fetch("./recorded.json", { cache: "no-cache" }); if (r.ok) M.recorded = await r.json(); } catch { /* optional */ }
  return (M.recorded ||= { vectors: {}, answers: {} });
}

/** The engine's brain: live models when loaded, else recorded answers. With M.capture set, live results are kept for recording. */
export const brain = {
  async embed(texts) {
    if (M.embedder) {
      const v = await M.embedder.embed(texts);
      if (M.capture) texts.forEach((t, i) => { M.capture.vectors[t] = encodeVec(v[i]); });
      return v;
    }
    return texts.map((t) => { const r = M.recorded?.vectors?.[t]; if (!r) throw new NeedModelsError("embed new text"); return decodeVec(r); });
  },
  async answer(state, questions, key) {
    if (M.laya) {
      const r = await M.laya.systemOne(state, questions);
      if (M.capture) M.capture.answers[key] = compactAnswers(r.answers);
      return r.answers;
    }
    const a = M.recorded?.answers?.[key];
    if (!a) throw new NeedModelsError("judge new text");
    return a;
  },
  live: () => !!(M.laya && M.embedder),
};
export const canPlay = (text) => brain.live() || !!M.recorded?.vectors?.[text];

// ---------- model card ----------
function setPill(kind, text) { const p = $("modelPill"); if (!p) return; p.className = "modelpill " + kind; $("modelPillText").textContent = text; }
export function setStatus(msg, warn = false) { const s = $("status"); if (!s) return; s.textContent = msg; s.classList.toggle("warn", warn); }
function setProgress(f) { const p = $("progress"); if (!p) return; p.hidden = f == null; if (f != null) $("progressBar").style.width = (f * 100).toFixed(1) + "%"; }
export function pillIdle() { if (!M.laya) setPill("replay", "Recorded playback · load the models for your own text"); }

export async function initModelCard() {
  $("loadBtn").addEventListener("click", loadModels);
  $("embedLink").href = EMBED_MODEL.page; $("embedLink").textContent = EMBED_MODEL.id;
  pillIdle();
  const m = await modelApi();
  const base = m.modelBase();
  const link = $("modelLink"); link.href = base === m.DEFAULT_MODEL_BASE ? m.MODEL_PAGE : base; link.textContent = base === m.DEFAULT_MODEL_BASE ? "VishalMysore/layaForWebTrained" : base;
  try {
    M.manifest = await m.fetchManifest(base);
    const sel = $("variant"); sel.innerHTML = "";
    const gpu = await m.hasWebGPU();
    const saved = settings.get("variant", gpu ? "q4e8" : "q8e8");
    for (const [k, v] of Object.entries(M.manifest.variants)) {
      const cached = await m.cachedParts(base, v.data);
      const tag = cached === v.data.parts.length ? ", cached" : cached ? `, ${cached}/${v.data.parts.length} parts cached` : "";
      sel.add(new Option(`${k === "q8e8" ? "int8 (WASM)" : k === "q4e8" ? "int4 (WebGPU, smaller)" : v.label} · ${Math.round(v.data.size / 1048576)} MB${tag}`, k));
    }
    if (M.manifest.variants[saved]) sel.value = saved;
    $("embedState").textContent = (await embedderCached()) ? " (cached)" : " (about 23 MB)";
    $("loadBtn").disabled = false;
  } catch (e) {
    setStatus(`Could not read the model manifest from ${base} (${e.message}). Recorded playback still works.`, true);
  }
}

export async function loadModels() {
  if (M.loading) return;
  M.loading = true; $("loadBtn").disabled = true; $("badges").innerHTML = "";
  setPill("busy", "Loading models…");
  settings.set("variant", $("variant").value);
  try {
    const m = await modelApi();
    if (!M.embedder) M.embedder = await loadEmbedder({ onStatus: setStatus, onProgress: setProgress });
    const { laya, backend, info } = await m.loadLaya({
      base: m.modelBase(), manifest: M.manifest, variant: $("variant").value, backend: $("backend").value,
      onStatus: setStatus, onProgress: setProgress,
    });
    M.laya = laya; M.model = { backend, ...info };
    setStatus(`Ready. Laya: download ${(info.downloadMs / 1000).toFixed(1)} s${info.fromCache ? ` (${info.fromCache}/${info.parts} parts from cache)` : ""}, session ${(info.initMs / 1000).toFixed(1)} s. Embedder ${(M.embedder.info.loadMs / 1000).toFixed(1)} s${M.embedder.info.fromCache ? " (cached)" : ""}. Any text now works.`);
    const badge = (t, ok) => { const b = document.createElement("span"); b.className = "badge" + (ok ? " ok" : ""); b.textContent = t; $("badges").appendChild(b); };
    badge(backend === "webgpu" ? "WebGPU" : `WASM · ${info.threads} thread${info.threads > 1 ? "s" : ""}`, true);
    badge(`judge: ${info.model || info.source} · ${info.variant}`); badge(`embeddings: ${EMBED_MODEL.id} · ${EMBED_MODEL.dim}-d`);
    setPill("ready", `Models ready · ${backend === "webgpu" ? "WebGPU" : "WASM"}`);
    $("loadBtn").textContent = "Reload models";
    for (const fn of M.listeners) fn();
  } catch (e) {
    console.error(e);
    setStatus("Could not load the models: " + (e?.message || e), true);
    pillIdle();
  } finally { M.loading = false; $("loadBtn").disabled = false; setProgress(null); }
}

export function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- rendering ----------
export const STATUS_TEXT = {
  active: "active", needs_review: "needs review", superseded: "superseded", contradicted: "contradicted",
  expired: "expired", frozen: "frozen", deleted: "deleted",
};
export const VERDICT_TEXT = {
  unrelated: "unrelated", confirmed: "confirmed", superseded: "superseded", contradicted: "contradicted",
  needs_review: "needs review", hypothetical: "question / plan", directive: "command",
  remembered: "remembered", freeze: "frozen by a person", unfreeze: "unfrozen", restore: "restored", forget: "forgotten",
  keep: "kept by a person", stale: "marked stale by a person", expired: "expired",
};
export const statusChip = (s) => `<span class="st st-${s}">${esc(STATUS_TEXT[s] || s)}</span>`;
export const verdictChip = (v) => `<span class="vd vd-${v}">${esc(VERDICT_TEXT[v] || v)}</span>`;

export function bars(probs, selected) {
  return `<div class="bars">${Object.entries(probs).map(([k, v]) => `<div class="bar${k === selected ? " sel" : ""}"><span class="n">${esc(k.replace(/_/g, " "))}</span><span class="tr"><span class="f" style="width:${(v * 100).toFixed(1)}%"></span></span><span class="v">${v.toFixed(2)}</span></div>`).join("")}</div>`;
}

/** The four staleness signals plus the combined score, as bars. */
export function voteBars(votes, policy) {
  const s = votes.signals;
  const rows = [
    ["“out of date or wrong”", s.outdated], ["after: outdated", s.after_outdated], ["not “still correct”", s.not_still_correct], ["replaces + contradicts", s.replaces_or_contradicts],
  ];
  const mark = (p) => `<i class="tick" style="left:${(p * 100).toFixed(1)}%"></i>`;
  return `<div class="votes">${rows.map(([n, v]) => `<div class="bar"><span class="n">${n}</span><span class="tr"><span class="f" style="width:${(v * 100).toFixed(1)}%"></span></span><span class="v">${v.toFixed(2)}</span></div>`).join("")}
    <div class="bar total"><span class="n"><b>stale score</b></span><span class="tr">${mark(policy.keep)}${mark(policy.stale)}<span class="f" style="width:${(votes.stale * 100).toFixed(1)}%"></span></span><span class="v"><b>${votes.stale.toFixed(2)}</b></span></div>
    <div class="votemeta">${votes.agree}/4 votes say stale · replaces share ${votes.share.toFixed(2)} · confirms ${votes.confirms.toFixed(2)}</div></div>`;
}
