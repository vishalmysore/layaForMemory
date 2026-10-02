"""Capture the screenshots used in docs/article.md from the deployed site.

    pip install playwright
    python scripts/capture_screenshots.py [--base https://vishalmysore.github.io/layaForMemory/] [--no-model] [--chrome PATH]

Drives the real pages in headless Chrome (WebGPU enabled). The first shots use the recorded playback (no download);
the live-model shots load Laya (int4, 278 MB) and the embedder once into a persistent profile under .cache/.
"""
import json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images"
OUT.mkdir(parents=True, exist_ok=True)
args = sys.argv[1:]
opt = lambda k, d=None: args[args.index(k) + 1] if k in args else d
BASE = opt("--base", "https://vishalmysore.github.io/layaForMemory/")
CHROME = opt("--chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe")
WITH_MODEL = "--no-model" not in args
notes = {}


def shot(page, name, selector=None):
    path = OUT / f"{name}.png"
    if selector:
        page.locator(selector).first.screenshot(path=str(path))
    else:
        page.screenshot(path=str(path))
    print("saved", path.relative_to(ROOT))


def open_page(page, name, ready="() => window.__lm || window.__lme"):
    page.goto(BASE + name)
    page.wait_for_function(ready, timeout=60_000)
    page.wait_for_timeout(1500)


def idle(page):
    page.wait_for_function("() => !document.body.classList.contains('busy')", timeout=900_000, polling=300)
    page.wait_for_timeout(500)


def tab(page, name):
    page.click(f'.tabs button[data-tab="{name}"]')
    page.wait_for_timeout(300)


def wipe(page, db):
    page.evaluate("""(db) => new Promise((r) => { const q = indexedDB.deleteDatabase(db); q.onsuccess = q.onerror = q.onblocked = () => r(); })""", db)
    page.evaluate("() => { Object.keys(localStorage).filter(k => k.startsWith('lm.')).forEach(k => localStorage.removeItem(k)); }")


def load_models(page):
    page.wait_for_function("() => !document.getElementById('loadBtn').disabled", timeout=60_000)
    page.select_option("#variant", "q4e8")
    page.click("#loadBtn")
    page.wait_for_function("() => document.getElementById('modelPill').classList.contains('ready') || /Could not/.test(document.getElementById('status').textContent)", timeout=1_200_000, polling=1000)
    page.wait_for_timeout(500)
    print("models:", page.inner_text("#status"))


with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(ROOT / ".cache" / "chrome-profile"), headless=True, executable_path=CHROME,
        args=["--enable-unsafe-webgpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
        viewport={"width": 1440, "height": 960}, device_scale_factor=1.25, color_scheme="light",
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.on("pageerror", lambda e: print("PAGE ERROR:", e))

    # 1. Playground, recorded playback, the demo one step at a time
    open_page(page, "index.html")
    wipe(page, "laya-memory-playground")
    open_page(page, "index.html")
    page.click("#stepBtn"); idle(page)                       # store the six facts
    shot(page, "01-playground-start")
    steps = {1: "02-outage-confirmed", 3: "03-injection-gated", 4: "04-migration-review", 5: "05-billing-contradicted", 6: "06-rate-limit-superseded"}
    for i in range(1, 7):
        page.click("#stepBtn"); idle(page)
        if i in steps:
            shot(page, steps[i], "#report")
    shot(page, "07-memories-after-demo", ".tabcard")
    tab(page, "review"); shot(page, "08-review-queue", ".tabcard")
    tab(page, "ledger"); shot(page, "09-ledger", ".tabcard")
    tab(page, "events"); shot(page, "10-events", ".tabcard")
    tab(page, "memories")
    page.fill("#query", "What is the API rate limit?")
    page.click("#recallBtn"); idle(page)
    shot(page, "11-recall", "#recallOut")
    page.evaluate("() => window.scrollTo(0, 0)")
    shot(page, "12-playground-overview")

    # 2. User actions app
    open_page(page, "app.html")
    wipe(page, "laya-memory-app")
    open_page(page, "app.html")
    idle(page)
    shot(page, "13-app-start")
    for name, val in [("city", "Austin"), ("diet", "pescatarian"), ("plan", "Pro"), ("city", "Lisbon")]:
        page.click(f'label:has(input[name="f-{name}"][value="{val}"])'); idle(page)
    shot(page, "14-app-city-report", "#report")
    for i in range(4):
        page.click(f'#msgChips button[data-i="{i}"]'); idle(page)
    page.click('#askChips button[data-i="0"]'); idle(page)
    shot(page, "15-app-overview")
    shot(page, "16-app-feed", "main.main > section.card")
    shot(page, "17-app-memories", ".tabcard")
    page.click('#askChips button[data-i="3"]'); idle(page)
    shot(page, "18-app-answer-review", ".phone")

    # 3. Evaluate
    open_page(page, "eval.html", "() => window.__lme")
    shot(page, "19-eval-kpis", "main.main > section.card")
    shot(page, "20-eval-confusion", "main.main > section.card:nth-of-type(2)")
    page.select_option("#filter", "wrong")
    page.wait_for_timeout(500)
    rows = page.locator("#cases tbody tr")
    rows.nth(0).screenshot(path=str(OUT / "21-eval-wrong-case.png")); print("saved docs/images/21-eval-wrong-case.png")
    page.select_option("#filter", "all")
    page.fill("#s-agree", "0"); page.dispatch_event("#s-agree", "input"); page.wait_for_timeout(500)
    shot(page, "22-eval-no-kill-switch", "main.main > section.card")
    notes["no_kill_switch"] = page.inner_text("#kpis")

    # 4. Live models: your own text
    if WITH_MODEL:
        open_page(page, "index.html")
        wipe(page, "laya-memory-playground")
        open_page(page, "index.html")
        load_models(page)
        shot(page, "23-model-card", "#modelCard")
        for t, src in [("The design team sits on floor 3 of Building A", "wiki"), ("Kiran is the on-call lead this month", "slack"), ("The company offsite is in Porto in June", "email")]:
            page.fill("#memText", t); page.select_option("#memSource", src); page.click("#rememberBtn"); idle(page)
        for t, src in [("The design team moved to floor 5 of Building C over the weekend", "slack"),
                       ("Could we hold the offsite in Seville instead?", "slack")]:
            page.fill("#evText", t); page.select_option("#evSource", src); page.click("#observeBtn"); idle(page)
            name = "24-live-move" if "moved" in t else "25-live-question"
            shot(page, name, "#report")
            notes[name] = page.evaluate("async () => (await window.__lm.mem.memories()).map(m => m.status + ' | ' + m.text)")
        tab(page, "memories"); shot(page, "26-live-memories", ".tabcard")

    # 5. Dark mode at phone width
    dark = ctx.new_page()
    dark.emulate_media(color_scheme="dark")
    dark.set_viewport_size({"width": 390, "height": 844})
    open_page(dark, "app.html")
    shot(dark, "27-dark-mobile")
    dark.close()

    (ROOT / ".cache" / "capture-notes.json").write_text(json.dumps(notes, indent=1), encoding="utf-8")
    ctx.close()
print("done")
