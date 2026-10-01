// Browser-local storage on IndexedDB. One database per "space" (the playground and the user-actions app keep
// separate memories). Object stores:
//   memories { id, text, source, kind, createdAt, ttl, status, pTrue, successorId, predecessorId, vec: Float32Array, updatedAt }
//   events   { id, ts, type, text, source, detail, observe, pending }   every user action, observed or not
//   ledger   { id, ts, eventId, memoryId, actor, verdict, reason, from, to, votes, applied }   append-only audit trail
//   answers  { key, answers }   Laya answers by question fingerprint + state, so nothing is asked twice
// If IndexedDB is unavailable (private window, blocked storage) everything falls back to memory for the tab's life.

const VERSION = 1;
const STORES = ["memories", "events", "ledger", "answers"];

/** @param opts { memoryOnly } keep everything in memory (used when recording playback data). */
export function openStore(name, { memoryOnly = false } = {}) {
  const mem = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  let dbp = null;
  const open = () => (dbp ||= new Promise((resolve) => {
    if (memoryOnly) return resolve(null);
    let req;
    try { req = indexedDB.open(name, VERSION); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("memories", { keyPath: "id" }).createIndex("byStatus", "status");
      db.createObjectStore("events", { keyPath: "id" }).createIndex("byTs", "ts");
      const l = db.createObjectStore("ledger", { keyPath: "id" });
      l.createIndex("byEvent", "eventId"); l.createIndex("byMemory", "memoryId");
      db.createObjectStore("answers", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { console.warn("IndexedDB unavailable, using memory:", req.error); resolve(null); };
    req.onblocked = () => resolve(null);
  }));
  const done = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

  const api = {
    name,
    async persistent() { return !!(await open()); },
    async put(store, row) { return api.putMany(store, [row]); },
    async putMany(store, rows) {
      const db = await open();
      if (!db) { for (const r of rows) mem[store].set(r.id ?? r.key, structuredClone(r)); return; }
      const tx = db.transaction(store, "readwrite");
      for (const r of rows) tx.objectStore(store).put(r);
      await txDone(tx);
    },
    async get(store, key) {
      const db = await open();
      if (!db) return mem[store].get(key) ?? null;
      return (await done(db.transaction(store).objectStore(store).get(key))) ?? null;
    },
    async all(store) {
      const db = await open();
      if (!db) return [...mem[store].values()];
      return done(db.transaction(store).objectStore(store).getAll());
    },
    async by(store, index, value) {
      const db = await open();
      if (!db) return [...mem[store].values()].filter((r) => r[{ byEvent: "eventId", byMemory: "memoryId", byStatus: "status" }[index]] === value);
      return done(db.transaction(store).objectStore(store).index(index).getAll(value));
    },
    async del(store, key) {
      const db = await open();
      if (!db) { mem[store].delete(key); return; }
      const tx = db.transaction(store, "readwrite"); tx.objectStore(store).delete(key); await txDone(tx);
    },
    /** Wipe this space. Keeps the answer cache unless `answers` is true (it only saves model calls). */
    async clear({ answers = false } = {}) {
      const stores = answers ? STORES : STORES.filter((s) => s !== "answers");
      for (const s of stores) mem[s].clear();
      const db = await open();
      if (!db) return;
      const tx = db.transaction(stores, "readwrite");
      for (const s of stores) tx.objectStore(s).clear();
      await txDone(tx);
    },
  };
  return api;
}

let seq = 0;
/** Sortable, unique-enough ids: time + counter + random. */
export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, "0")}${Math.random().toString(36).slice(2, 6)}`;
