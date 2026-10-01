// Grid-search the policy thresholds on the recorded eval answers (web/recorded.json), with false invalidations as the
// hard constraint, and a two-fold check (fit on even cases, score odd, and the other way) to show how optimistic
// the in-sample numbers are.   node scripts/tune.mjs
import fs from "node:fs";
import { DEFAULT_POLICY, eventVotes, pairVotes, decide, eventCacheKey, pairCacheKey, STALE, DESTRUCTIVE } from "../web/governor-core.js";

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../web/${f}`, import.meta.url)));
const rec = read("recorded.json"), { cases } = read("cases.json");
const rows = cases.map((c) => {
  const e = { text: c.event, source: c.evSource }, m = { text: c.memory, source: c.memSource };
  return { c, k: eventVotes(rec.answers[eventCacheKey(e)]), p: pairVotes(rec.answers[pairCacheKey(m, e)]) };
});

function score(rs, P) {
  let strict = 0, lenient = 0, falseInv = 0, closed = 0;
  for (const { c, k, p } of rs) {
    const v = decide(k, p, P).verdict, e = c.expected;
    strict += v === e;
    lenient += STALE.has(e) ? STALE.has(v) : ["confirmed", "unrelated"].includes(e) ? ["confirmed", "unrelated"].includes(v) : v === e;
    falseInv += DESTRUCTIVE.has(v) && !STALE.has(e);
    closed += DESTRUCTIVE.has(v) && DESTRUCTIVE.has(e);
  }
  return { strict: strict / rs.length, lenient: lenient / rs.length, falseInv, closed, n: rs.length };
}
/** Lexicographic: fewer false invalidations, then lenient accuracy, then stale facts closed, then strict accuracy. */
const better = (x, y) => { const i = x.findIndex((v, j) => v !== y[j]); return i >= 0 && x[i] > y[i]; };
const range =(a, b, s) => Array.from({ length: Math.round((b - a) / s) + 1 }, (_, i) => +(a + i * s).toFixed(3));
function best(rs) {
  let top = null;
  for (const keep of range(0.36, 0.56, 0.01)) for (const stale of range(keep, 0.64, 0.01)) for (const agree of [0, 2, 3, 4]) {
    const P = { ...DEFAULT_POLICY, keep, stale, agree };
    const s = score(rs, P);
    const key = [-s.falseInv, s.lenient, s.closed, s.strict];
    if (!top || better(key, top.key)) top = { key, P, s };
  }
  return top;
}
const fmt = (s) => `strict ${(s.strict * 100).toFixed(1)}%  lenient ${(s.lenient * 100).toFixed(1)}%  false invalidations ${s.falseInv}  stale closed ${s.closed}`;
const pick = (P) => `keep ${P.keep} stale ${P.stale} agree ${P.agree}`;

console.log(`defaults (${pick(DEFAULT_POLICY)}) on all ${rows.length}: ${fmt(score(rows, DEFAULT_POLICY))}`);
const all = best(rows);
console.log(`best in-sample (${pick(all.P)}): ${fmt(all.s)}`);
const A = rows.filter((_, i) => i % 2 === 0), B = rows.filter((_, i) => i % 2 === 1);
const a = best(A), b = best(B);
console.log(`fit even -> score odd  (${pick(a.P)}): ${fmt(score(B, a.P))}`);
console.log(`fit odd  -> score even (${pick(b.P)}): ${fmt(score(A, b.P))}`);
