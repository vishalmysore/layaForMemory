// recorded.json must match the current question wording and cover every built-in text, or the pages would ask for
// the models in the middle of the demo. Re-record with: python scripts/drive.py record
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULT_POLICY, EVENT_KEY, PAIR_KEY, eventVotes, pairVotes, decide, eventCacheKey, pairCacheKey, STALE, DESTRUCTIVE } from "../web/governor-core.js";

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../web/${f}`, import.meta.url)));
const rec = read("recorded.json"), sc = read("scenarios.json"), { cases } = read("cases.json");

test("recorded answers use the current question wording", () => {
  assert.equal(rec.model.eventKey, EVENT_KEY, "event questions changed: re-record");
  assert.equal(rec.model.pairKey, PAIR_KEY, "pair questions changed: re-record");
});

test("every built-in text has a vector and every event has its kind answer", () => {
  const fill = (t, o) => t.replace(/\{(\w+)\}/g, (_, k) => o[k]);
  const evs = [...sc.playground.events];
  for (const f of sc.app.fields) for (const o of f.options) for (const n of f.options) if (o !== n) evs.push({ text: fill(f.event, { old: o, new: n }), source: "settings" });
  evs.push(...sc.app.messages);
  for (const e of evs) {
    assert.ok(rec.vectors[e.text], `vector: ${e.text}`);
    assert.ok(rec.answers[eventCacheKey(e)], `kind: ${e.text}`);
  }
  for (const q of [...sc.playground.queries, ...sc.app.queries]) assert.ok(rec.vectors[q], `query vector: ${q}`);
  for (const m of [...sc.playground.memories, ...sc.app.seedMemories]) assert.ok(rec.vectors[m.text], `memory vector: ${m.text}`);
});

test("default policy on the recorded eval answers: no false invalidations", () => {
  let strict = 0, lenient = 0, falseInv = 0;
  for (const c of cases) {
    const e = { text: c.event, source: c.evSource }, m = { text: c.memory, source: c.memSource };
    const ea = rec.answers[eventCacheKey(e)], pa = rec.answers[pairCacheKey(m, e)];
    assert.ok(ea && pa, `answers for ${c.id}`);
    const v = decide(eventVotes(ea), pairVotes(pa), DEFAULT_POLICY).verdict;
    strict += v === c.expected;
    lenient += STALE.has(c.expected) ? STALE.has(v) : ["confirmed", "unrelated"].includes(c.expected) ? ["confirmed", "unrelated"].includes(v) : v === c.expected;
    falseInv += DESTRUCTIVE.has(v) && !STALE.has(c.expected);
  }
  console.log(`strict ${strict}/${cases.length}, lenient ${lenient}/${cases.length}, false invalidations ${falseInv}`);
  assert.equal(falseInv, 0);
  assert.ok(lenient / cases.length >= 0.75);
});
