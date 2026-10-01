// Records the user's actions on a page into the memory's event log (IndexedDB). Every click on an element with
// data-track="name", and every change of a form control with data-track, becomes an event row. These raw UI
// actions are logged but not observed (they carry no claim about the world). Pages turn the meaningful ones,
// such as "changed home city from Boston to Austin", into observed events with a sentence via mem.track({ text }).
export function attachTracker(mem, root = document) {
  const label = (el) => el.dataset.track || el.id || el.name || el.tagName.toLowerCase();
  root.addEventListener("click", (e) => {
    const el = e.target.closest("[data-track]");
    if (!el || el.matches("select, input, textarea")) return;
    mem.track({ type: "click", source: "ui", detail: { target: label(el), text: el.textContent.trim().slice(0, 60), page: location.pathname.split("/").pop() || "index.html" } }).catch(console.error);
  }, true);
  root.addEventListener("change", (e) => {
    const el = e.target.closest("[data-track]");
    if (!el || !el.matches("select, input, textarea")) return;
    const value = el.type === "checkbox" ? el.checked : el.type === "radio" ? el.value : String(el.value).slice(0, 60);
    mem.track({ type: "change", source: "ui", detail: { target: label(el), value, page: location.pathname.split("/").pop() || "index.html" } }).catch(console.error);
  }, true);
  const visit = () => mem.track({ type: "visit", source: "ui", detail: { page: location.pathname.split("/").pop() || "index.html", visible: document.visibilityState } }).catch(console.error);
  visit();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") visit(); });
}
