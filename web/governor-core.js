// The invalidation policy, with no browser or model dependencies so it can be unit-tested in Node.
//
// Idea (after chopratejas/invalidate): a stored memory is never edited. When a new event arrives, a small model
// answers a few typed questions about the event and about each (memory, event) pair, and a fixed policy turns the
// answers into a verdict: unrelated, confirmed, superseded, contradicted or needs_review. Questions, plans and
// commands never change memory. Here the model is Laya, running in the browser tab.
//
// The question wording and the thresholds below were chosen by measuring Laya on web/cases.json (62 labeled pairs).
// The first attempt copied invalidate's six yes/no votes; on this checkpoint "same subject" came out inverted and
// "is it hypothetical" had no signal (see README, "How the questions were chosen").

export const QUESTIONS = {
  // Asked once per event, on the event alone.
  event: {
    kind: {
      type: "choice", instructions: "What kind of message is the event?", criteria: {
        report: "It reports a fact or something that happened or changed",
        question: "It asks a question",
        proposal: "It suggests, plans or wonders about a possible future change",
        command: "It orders the assistant to change, forget or ignore what it remembers",
      },
    },
  },
  // Asked once per candidate memory, on { memory, event }. All four run as one batch.
  pair: {
    outdated: { type: "noul", instructions: "Given the newer event, the memory is now out of date or wrong" },
    after: {
      type: "choice", instructions: "After this event, is the memory still correct?", criteria: {
        unaffected: "The event is about a different subject",
        still_correct: "The memory is still correct",
        outdated: "The memory is now wrong or out of date",
      },
    },
    still_correct: { type: "noul", instructions: "The memory is still correct after the event" },
    relation: {
      type: "choice", instructions: "What does the event mean for the memory?", criteria: {
        unrelated: "The event is about something else, so the memory is unaffected",
        confirms: "The event agrees with the memory or is consistent with it",
        replaces: "The event gives a new value for the same thing, so the memory is out of date",
        contradicts: "The event says the memory is no longer true or never was",
        minor_change: "The memory is mostly still right; only a small detail changed",
      },
    },
  },
};

/** Thresholds, tuned on web/cases.json with false invalidations as the hard constraint (see README). */
export const DEFAULT_POLICY = {
  command: 0.5,        // p(command) at or above: the event is an instruction, logged only (prompt-injection defense)
  hypothetical: 0.5,   // p(question) + p(proposal) at or above: a question or plan, logged only
  keep: 0.45,          // stale score at or below: the memory stands (confirmed or unrelated)
  stale: 0.5,          // stale score at or above: the memory is out of date; in between: needs_review
  agree: 3,            // kill switch: a destructive verdict needs at least this many of the 4 votes to agree, else needs_review
  replaces: 0.5,       // share of "replaces" in replaces + contradicts at or above: superseded, else contradicted
  confirms: 0.2,       // p(confirms) at or above, for a memory that stands: confirmed, else unrelated
  minSim: 0.2,         // embedding pre-screen: pairs below this cosine are not sent to Laya
  topK: 6,             // at most this many candidate memories per event
};

export const VERDICTS = ["unrelated", "confirmed", "superseded", "contradicted", "needs_review", "hypothetical", "directive"];
export const DESTRUCTIVE = new Set(["superseded", "contradicted"]);
export const STALE = new Set(["superseded", "contradicted", "needs_review"]);
export const STATUSES = ["active", "needs_review", "superseded", "contradicted", "expired", "frozen", "deleted"];

const r3 = (x) => Math.round(x * 1000) / 1000;

/** Event answers (Laya output for QUESTIONS.event) -> { command, hypothetical, kind }. */
export function eventVotes(answers) {
  const p = answers.kind.probabilities;
  return { command: r3(p.command), hypothetical: r3(p.question + p.proposal), kind: p };
}

/**
 * Pair answers (Laya output for QUESTIONS.pair) -> derived votes:
 *   stale   mean of four staleness signals (each in [0, 1]); the main score
 *   agree   how many of the four, read on their own, say "stale"
 *   share   p(replaces) / (p(replaces) + p(contradicts)): does the event carry the new value?
 *   confirms p(confirms)
 */
export function pairVotes(answers) {
  const outdated = answers.outdated.noul;
  const after = answers.after.probabilities;
  const still = answers.still_correct.noul;
  const rel = answers.relation.probabilities;
  const change = rel.replaces + rel.contradicts;
  const stale = (outdated + after.outdated + (1 - still) + change) / 4;
  const agree = [outdated >= 0.5, after.outdated >= Math.max(...Object.values(after)), still < 0.3, change >= 0.5].filter(Boolean).length;
  return {
    stale: r3(stale), agree, share: r3(rel.replaces / Math.max(1e-9, change)), confirms: r3(rel.confirms),
    signals: { outdated: r3(outdated), after_outdated: r3(after.outdated), not_still_correct: r3(1 - still), replaces_or_contradicts: r3(change) },
  };
}

/**
 * Votes -> { verdict, reason }. Order of checks is the policy: commands and questions first (they never touch
 * memory), then whether the memory stands, then the review band, then the kill switch, then the kind of change.
 */
export function decide(ev, pair, policy = DEFAULT_POLICY) {
  const P = { ...DEFAULT_POLICY, ...policy };
  if (ev.command >= P.command) return { verdict: "directive", reason: `the event is a command (p ${f(ev.command)} ≥ ${P.command}); logged, memory untouched` };
  if (ev.hypothetical >= P.hypothetical) return { verdict: "hypothetical", reason: `the event is a question or plan (p ${f(ev.hypothetical)} ≥ ${P.hypothetical}); logged, memory untouched` };
  if (!pair) return { verdict: "unrelated", reason: "not similar enough to be checked" };
  if (pair.stale <= P.keep) {
    return pair.confirms >= P.confirms
      ? { verdict: "confirmed", reason: `memory stands (stale ${f(pair.stale)} ≤ ${P.keep}) and the event agrees (confirms ${f(pair.confirms)})` }
      : { verdict: "unrelated", reason: `memory stands (stale ${f(pair.stale)} ≤ ${P.keep})` };
  }
  if (pair.stale < P.stale) return { verdict: "needs_review", reason: `unsure (stale ${f(pair.stale)} between ${P.keep} and ${P.stale})` };
  const verdict = pair.share >= P.replaces ? "superseded" : "contradicted";
  if (pair.agree < P.agree) return { verdict: "needs_review", killed: verdict, reason: `would be ${verdict}, but only ${pair.agree} of 4 votes agree (kill switch needs ${P.agree})` };
  return {
    verdict,
    reason: verdict === "superseded"
      ? `out of date (stale ${f(pair.stale)}, ${pair.agree}/4 votes) and the event carries the new value (share ${f(pair.share)})`
      : `out of date (stale ${f(pair.stale)}, ${pair.agree}/4 votes); the event says it no longer holds`,
  };
}
const f = (x) => (x == null ? "–" : x.toFixed(2));

/**
 * Lifecycle. Returns the memory's changed fields for a verdict, or null when nothing changes.
 *   active ──unsure──► needs_review ──confirmed──► active
 *   active/needs_review ──superseded──► superseded (successorId = the event stored as a new memory, if any)
 *   active/needs_review ──contradicted──► contradicted
 *   frozen, deleted, expired, superseded, contradicted: never moved by an event (a person can restore them)
 * pTrue is the belief that the memory still holds: 1 - stale score of the latest relevant check.
 */
export function transition(memory, verdict, pair, successorId = null) {
  if (!["active", "needs_review"].includes(memory.status)) return null;
  const pt = pair ? r3(1 - pair.stale) : memory.pTrue;
  switch (verdict) {
    case "confirmed": return { status: "active", pTrue: Math.max(memory.pTrue ?? 1, pt) };
    case "needs_review": return { status: "needs_review", pTrue: pt };
    case "superseded": return { status: "superseded", pTrue: pt, successorId };
    case "contradicted": return { status: "contradicted", pTrue: pt };
    default: return null; // unrelated, hypothetical, directive: logged, memory untouched
  }
}

/** Memories whose lease (ttl, seconds) ran out. Frozen memories never expire. */
export function expiredIds(memories, now = Date.now()) {
  return memories.filter((m) => m.ttl && ["active", "needs_review"].includes(m.status) && now - m.createdAt > m.ttl * 1000).map((m) => m.id);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are L2-normalized by the embedder
}

/** Candidate memories for an event: live ones (active / needs_review) above minSim, best first, at most topK. */
export function candidates(memories, eventVec, policy = DEFAULT_POLICY) {
  const P = { ...DEFAULT_POLICY, ...policy };
  return memories
    .filter((m) => ["active", "needs_review"].includes(m.status) && m.vec)
    .map((m) => ({ m, sim: cosine(m.vec, eventVec) }))
    .filter((x) => x.sim >= P.minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, P.topK);
}

/** Recall ranking: similarity times belief. Active and frozen memories, plus needs_review on request; below minSim is not a match. */
export function rank(memories, queryVec, { limit = 5, includeReview = false, minSim = 0.15 } = {}) {
  const ok = new Set(includeReview ? ["active", "frozen", "needs_review"] : ["active", "frozen"]);
  return memories
    .filter((m) => ok.has(m.status) && m.vec)
    .map((m) => { const sim = cosine(m.vec, queryVec); return { m, sim, score: sim * (m.pTrue ?? 1) }; })
    .filter((x) => x.sim >= minSim)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** The states Laya sees. Plain objects; laya-core serializes them the way the Python original does. */
export const eventState = (event) => ({ event: event.text, source: event.source || "unknown" });
export const pairState = (memory, event) => ({
  memory: memory.text, memory_source: memory.source || "unknown",
  event: event.text, event_source: event.source || "unknown",
});

/** Fingerprint (FNV-1a), so recorded answers are only replayed if the wording is unchanged. */
export function questionKey(q) {
  const s = JSON.stringify(q);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
export const EVENT_KEY = questionKey(QUESTIONS.event);
export const PAIR_KEY = questionKey(QUESTIONS.pair);
export const eventCacheKey = (event) => `${EVENT_KEY}|${event.source || "unknown"}|${event.text}`;
export const pairCacheKey = (memory, event) => `${PAIR_KEY}|${memory.source || "unknown"}|${memory.text}|${event.source || "unknown"}|${event.text}`;
