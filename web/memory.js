// The memory governor: remember / observe / recall over a browser store, with Laya deciding what an event does to
// each stored memory. Memory text is never edited. Every verdict is written to the ledger BEFORE the memory changes
// (write-ahead), and recover() finishes any change a closed tab left half-done.
//
// The engine does not load models itself. It gets a "brain": { embed(texts) -> Float32Array[], answer(state, questions, key) -> answers }.
// The pages build one from the live models, falling back to answers recorded from the same models.
import {
  QUESTIONS, DEFAULT_POLICY, DESTRUCTIVE, eventVotes, pairVotes, decide, transition, expiredIds, candidates, rank, cosine,
  eventState, pairState, eventCacheKey, pairCacheKey,
} from "./governor-core.js";
import { newId } from "./store.js";

export class NeedModelsError extends Error {
  constructor(what) { super(`Load the models to ${what}: this text is not in the recorded playback.`); this.name = "NeedModelsError"; }
}

export class LayaMemory {
  /**
   * @param store  openStore(...) result
   * @param brain  { embed, answer }
   * @param opts   { policy, mode: "eager" | "lazy", rememberSuccessor: boolean }
   */
  constructor(store, brain, opts = {}) {
    this.store = store; this.brain = brain;
    this.policy = { ...DEFAULT_POLICY, ...(opts.policy || {}) };
    this.mode = opts.mode || "eager";
    this.rememberSuccessor = opts.rememberSuccessor ?? true;
    this.listeners = new Set();
    this.stats = { layaCalls: 0, cached: 0, ms: 0 };
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { for (const fn of this.listeners) { try { fn(type, data); } catch (e) { console.error(e); } } }

  // ---------- model access, with the answer cache in front ----------
  async ask(state, questions, key) {
    const hit = await this.store.get("answers", key);
    if (hit) { this.stats.cached++; return { answers: hit.answers, ms: 0, cached: true }; }
    const t0 = performance.now();
    const answers = await this.brain.answer(state, questions, key);
    const ms = performance.now() - t0;
    this.stats.layaCalls++; this.stats.ms += ms;
    await this.store.put("answers", { key, answers });
    return { answers, ms, cached: false };
  }
  async embedOne(text) { return (await this.brain.embed([text]))[0]; }

  // ---------- reads ----------
  memories() { return this.store.all("memories"); }
  async events() { return (await this.store.all("events")).sort((a, b) => a.ts - b.ts); }
  async ledger() { return (await this.store.all("ledger")).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)); }

  // ---------- writes ----------
  /** Store a fact verbatim. */
  async remember(text, { source = "chat", kind = "fact", ttl = null, predecessorId = null, topic = null, createdAt = Date.now() } = {}) {
    text = String(text).trim();
    if (!text) throw new Error("empty memory");
    const m = {
      id: newId("m"), text, source, kind, ttl, createdAt, updatedAt: createdAt,
      status: "active", pTrue: 1, successorId: null, predecessorId, topic, vec: await this.embedOne(text),
    };
    await this.store.put("memories", m);
    await this.log({ memoryId: m.id, actor: predecessorId ? "laya" : "person", verdict: "remembered", reason: predecessorId ? "stored verbatim as the successor of a superseded memory" : `stored verbatim (source ${source})`, from: null, to: "active", applied: true });
    this.emit("memory", m);
    return m;
  }

  /**
   * Log any user action. Actions with text are observed: checked against memory (now, or at recall in lazy mode).
   *   topic:    the action's known subject (e.g. a settings field). It is then checked only against facts with the
   *             same topic, instead of every similar fact: Laya mixes up parallel sentences about different subjects.
   *   remember: the action is authoritative (the user changed it themselves), so its text is always stored as a fact.
   */
  async track(action) {
    const e = {
      id: newId("e"), ts: Date.now(), type: action.type || "message", source: action.source || "ui",
      text: action.text ? String(action.text).trim() : null, detail: action.detail ?? null,
      observe: !!action.text && action.observe !== false, pending: false,
      topic: action.topic ?? null, remember: !!action.remember, kind: action.kind ?? null,
    };
    if (e.observe) { e.vec = await this.embedOne(e.text); e.pending = true; }
    await this.store.put("events", e);
    this.emit("event", e);
    if (e.observe && this.mode === "eager" && !action.defer) return { event: e, report: await this.judge(e, action) };
    return { event: e, report: null };
  }
  /** Shorthand for an observed text event (Slack message, email, chat line, ...). */
  observe(text, { source = "chat", type = "message", ...opts } = {}) { return this.track({ type, source, text, ...opts }); }

  /**
   * Check one event against memory. Returns a report:
   *   { event, kind: {command, hypothetical, kind}, verdict (event-level, if gated), checks: [...], successor }
   * Each check: { memory, sim, votes, verdict, reason, killed, from, to, cached, ms }.
   * Pairs already in the ledger for this event are skipped (lazy recall may have judged them).
   */
  async judge(event, { dryRun = false, rememberSuccessor = this.rememberSuccessor, onlyIds = null } = {}) {
    this.emit("judging", event);
    const ek = await this.ask(eventState(event), QUESTIONS.event, eventCacheKey(event));
    const kind = eventVotes(ek.answers);
    const report = { event, kind, checks: [], successor: null, dryRun, ms: ek.ms };
    const gate = decide(kind, null, this.policy);
    if (gate.verdict === "directive" || gate.verdict === "hypothetical") {
      report.verdict = gate.verdict; report.reason = gate.reason;
      if (!dryRun) {
        await this.log({ eventId: event.id, memoryId: null, actor: "laya", verdict: gate.verdict, reason: gate.reason, votes: kind, applied: true });
        await this.finishEvent(event);
      }
      this.emit("judged", report);
      return report;
    }

    const done = new Set((await this.store.by("ledger", "byEvent", event.id)).map((l) => l.memoryId));
    let pool = await this.memories();
    if (onlyIds) pool = pool.filter((m) => onlyIds.includes(m.id));
    pool = pool.filter((m) => !done.has(m.id) && m.createdAt <= event.ts && m.id !== event.successorId && (!event.topic || m.topic === event.topic));
    for (const { m, sim } of candidates(pool, event.vec, this.policy)) {
      const pk = await this.ask(pairState(m, event), QUESTIONS.pair, pairCacheKey(m, event));
      const votes = pairVotes(pk.answers);
      const d = decide(kind, votes, this.policy);
      report.checks.push({ memory: m, sim, votes, verdict: d.verdict, reason: d.reason, killed: d.killed || null, from: m.status, to: m.status, cached: pk.cached, ms: pk.ms });
      report.ms += pk.ms;
    }
    if (!dryRun) {
      // A superseded memory points at its successor: the event text, stored verbatim as a new memory (once per event).
      const live = (c) => ["active", "needs_review"].includes(c.memory.status);
      const sup = report.checks.find((c) => c.verdict === "superseded" && live(c));
      const prev = sup || report.checks.find((c) => c.verdict === "contradicted" && live(c));
      let successorId = event.successorId || null;
      if (!successorId && ((sup && rememberSuccessor) || event.remember)) {
        const s = await this.remember(event.text, { source: event.source, kind: event.kind || prev?.memory.kind || "fact", topic: event.topic, predecessorId: prev?.memory.id ?? null, createdAt: event.ts });
        successorId = s.id; report.successor = s;
        event.successorId = s.id;
      }
      for (const c of report.checks) {
        const change = transition(c.memory, c.verdict, c.votes, c.verdict === "superseded" ? successorId : null);
        c.to = change?.status ?? c.memory.status;
        await this.apply(c.memory, change, { eventId: event.id, actor: "laya", verdict: c.verdict, reason: c.reason, votes: c.votes, sim: c.sim, killed: c.killed });
      }
      await this.finishEvent(event);
    }
    this.emit("judged", report);
    return report;
  }

  async finishEvent(event) {
    event.pending = false;
    await this.store.put("events", event);
  }

  /** Write-ahead: ledger row (applied: false) -> memory update -> ledger row applied. */
  async apply(memory, change, entry) {
    const row = await this.log({ ...entry, memoryId: memory.id, from: memory.status, to: change?.status ?? memory.status, change, applied: !change });
    if (!change) return;
    Object.assign(memory, change, { updatedAt: Date.now() });
    await this.store.put("memories", memory);
    row.applied = true;
    await this.store.put("ledger", row);
    this.emit("memory", memory);
  }
  async log(entry) {
    const row = { id: newId("l"), ts: Date.now(), eventId: null, memoryId: null, actor: "laya", votes: null, ...entry };
    await this.store.put("ledger", row);
    this.emit("ledger", row);
    return row;
  }

  /** Finish changes a closed tab left half-done (ledger rows with applied: false). Returns how many were replayed. */
  async recover() {
    let n = 0;
    for (const row of await this.ledger()) {
      if (row.applied || !row.change) continue;
      const m = await this.store.get("memories", row.memoryId);
      if (m) { Object.assign(m, row.change, { updatedAt: Date.now() }); await this.store.put("memories", m); }
      row.applied = true; row.recovered = true;
      await this.store.put("ledger", row); n++;
    }
    return n;
  }

  /**
   * Recall: rank by similarity × belief. In lazy mode, first check pending events against the memories about to be
   * returned (only those pairs), so a stale memory is caught at the moment it would be used.
   */
  async recall(query, { limit = 5, includeReview = false, minSim = 0.15 } = {}) {
    const qv = await this.embedOne(query);
    const lazyReports = [];
    if (this.mode === "lazy") {
      const top = rank(await this.memories(), qv, { limit: limit * 2, includeReview: true, minSim: 0 });
      const ids = top.map((t) => t.m.id);
      for (const e of (await this.events()).filter((x) => x.pending)) {
        if (!top.some((t) => cosine(t.m.vec, e.vec) >= this.policy.minSim && t.m.createdAt <= e.ts)) continue;
        lazyReports.push(await this.judgeLazy(e, ids));
      }
    }
    const hits = rank(await this.memories(), qv, { limit, includeReview, minSim });
    return { query, hits, lazyReports };
  }
  /** Lazy check of one pending event against some memories; the event stays pending for the rest. */
  async judgeLazy(event, ids) {
    const r = await this.judge(event, { onlyIds: ids });
    if (!r.verdict) { event.pending = true; await this.store.put("events", event); } // judge() cleared it
    return r;
  }
  /** Judge every pending event in full (the lazy-mode backlog). */
  async processPending() {
    const out = [];
    for (const e of (await this.events()).filter((x) => x.pending)) out.push(await this.judge(e));
    return out;
  }

  /** A person's decision. action: freeze | unfreeze | restore | forget | keep (review -> active) | stale (review -> superseded by eventId). */
  async act(memoryId, action, { eventId = null, note = "" } = {}) {
    const m = await this.store.get("memories", memoryId);
    if (!m) throw new Error("no such memory");
    const to = { freeze: "frozen", unfreeze: "active", restore: "active", forget: "deleted", keep: "active", stale: "superseded" }[action];
    if (!to) throw new Error("unknown action " + action);
    const change = { status: to };
    if (action === "keep" || action === "restore") change.pTrue = 1;
    if (action === "stale" && eventId) {
      const e = await this.store.get("events", eventId);
      if (e) {
        let sid = e.successorId;
        if (!sid) { const s = await this.remember(e.text, { source: e.source, kind: m.kind, predecessorId: m.id, createdAt: e.ts }); sid = s.id; e.successorId = sid; await this.store.put("events", e); }
        change.successorId = sid;
      }
    }
    await this.apply(m, change, { eventId, actor: "person", verdict: action, reason: note || `person chose "${action}"` });
    return m;
  }

  /** Expire memories whose lease ran out, and in lazy mode work through the backlog. */
  async sweep({ pending = true } = {}) {
    const all = await this.memories();
    const ids = expiredIds(all);
    for (const id of ids) {
      const m = all.find((x) => x.id === id);
      await this.apply(m, { status: "expired" }, { actor: "system", verdict: "expired", reason: `lease of ${m.ttl}s ran out` });
    }
    const reports = pending ? await this.processPending() : [];
    return { expired: ids.length, reports };
  }

  /** Full dump (vectors dropped) for download; import re-embeds. */
  async exportAll() {
    const strip = (r) => { const { vec, ...rest } = r; return rest; };
    return { format: "laya-memory/1", exportedAt: new Date().toISOString(), memories: (await this.memories()).map(strip), events: (await this.events()).map(strip), ledger: await this.ledger() };
  }
  async importAll(dump) {
    if (dump?.format !== "laya-memory/1") throw new Error("not a laya-memory export");
    const mems = dump.memories || [], evs = dump.events || [];
    const vecs = await this.brain.embed([...mems.map((m) => m.text), ...evs.filter((e) => e.text && e.observe).map((e) => e.text)]);
    let i = 0;
    for (const m of mems) m.vec = vecs[i++];
    for (const e of evs) if (e.text && e.observe) e.vec = vecs[i++];
    await this.store.putMany("memories", mems);
    await this.store.putMany("events", evs);
    await this.store.putMany("ledger", dump.ledger || []);
    this.emit("reset", null);
  }
}

export { DESTRUCTIVE };
