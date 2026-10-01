"""Drive the pages in headless Chrome: measure Laya's votes on the labeled cases, record playback data, run ad-hoc JS.

    pip install playwright
    python scripts/drive.py votes  [--variant q4e8] [--backend auto] [--set v1] [--out .cache/votes-v1.json]
    python scripts/drive.py record                                                # playback data -> web/recorded.json (reuses answers already there; --fresh to redo all)
    python scripts/drive.py probe QUESTIONS.json [--out .cache/probe.json]        # try question wordings on cases.json
    python scripts/drive.py js FILE.js [--page lab.html] [--out result.json]     # FILE.js: an async function body; `return` a JSON value

Serves nothing itself: start the site first (`python serve.py 5194`) or pass --base. Uses an installed Chrome (--chrome PATH)
with WebGPU enabled and a persistent profile under .cache/, so the model downloads once. A headless browser is not
throttled the way a hidden tab is, so long runs keep their speed.
"""
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
args = sys.argv[1:]
cmd = args[0] if args else "help"
opt = lambda k, d=None: args[args.index(k) + 1] if k in args else d
BASE = opt("--base", "http://localhost:5194/")
CHROME = opt("--chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe")
VARIANT, BACKEND, SET = opt("--variant", "q4e8"), opt("--backend", "auto"), opt("--set", "v1")


def launch(p):
    return p.chromium.launch_persistent_context(
        str(ROOT / ".cache" / "chrome-profile"), headless=True, executable_path=CHROME,
        args=["--enable-unsafe-webgpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
              "--disable-backgrounding-occluded-windows"], viewport={"width": 1440, "height": 960},
    )


def open_page(ctx, name, ready):
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.on("pageerror", lambda e: print("PAGE ERROR:", e))
    page.on("console", lambda m: m.type in ("error", "warning") and print("console:", m.text[:300]))
    page.goto(BASE + name)
    page.wait_for_function(ready, timeout=120_000, polling=500)
    return page


def run_job(page, js, arg=None, progress_js="() => document.getElementById('st')?.textContent || ''", every=10):
    """Start an async job in the page and poll for it, so no single evaluate call runs into a timeout."""
    page.evaluate("""([js, arg]) => { window.__job = { done: false }; (async () => (0, eval)('(' + js + ')')(arg))()
        .then((r) => { window.__job.result = r; }).catch((e) => { window.__job.error = String(e && e.stack || e); })
        .finally(() => { window.__job.done = true; }); }""", [js, arg])
    t0 = time.time()
    while not page.evaluate("() => window.__job.done"):
        time.sleep(every)
        print(f"  {time.time() - t0:6.0f}s  {page.evaluate(progress_js) if progress_js else ''}", flush=True)
    err = page.evaluate("() => window.__job.error || null")
    if err:
        raise SystemExit("job failed: " + err)
    return page.evaluate("() => window.__job.result")


def write(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print("wrote", path)


if cmd == "votes":
    cases = json.loads((ROOT / "web" / "cases.json").read_text(encoding="utf-8"))["cases"]
    with sync_playwright() as p:
        ctx = launch(p)
        page = open_page(ctx, "lab.html", "() => window.__lab")
        info = run_job(page, "async ({ v, b }) => window.__lab.load(v, b)", {"v": VARIANT, "b": BACKEND})
        print("model:", info)
        t0 = time.time()
        res = run_job(page, "async ({ cases, set }) => window.__lab.run(cases, set)", {"cases": cases, "set": SET})
        write(opt("--out", str(ROOT / ".cache" / f"votes-{SET}-{VARIANT}.json")),
              {"model": info, "set": SET, "seconds": round(time.time() - t0, 1), "votes": res})
        ctx.close()
elif cmd == "record":  # python scripts/drive.py record   -> web/recorded.json
    with sync_playwright() as p:
        ctx = launch(p)
        page = open_page(ctx, "lab.html", "() => window.__lab")
        print("model:", run_job(page, "async ({ v, b }) => window.__lab.load(v, b, true)", {"v": VARIANT, "b": BACKEND}))
        out = ROOT / "web" / "recorded.json"
        prev = {} if "--fresh" in args or not out.exists() else json.loads(out.read_text(encoding="utf-8")).get("answers", {})
        res = run_job(page, "async (prev) => window.__lab.record(prev)", prev, every=20)
        out.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print("wrote", out, f"{out.stat().st_size / 1024:.0f} KB,", len(res["answers"]), "answers,", len(res["vectors"]), "vectors,", res["model"]["seconds"], "s")
        ctx.close()
elif cmd == "probe":  # python scripts/drive.py probe QUESTIONS.json --out .cache/probe.json   ({"event": {...}, "pair": {...}})
    qs = json.loads(Path(args[1]).read_text(encoding="utf-8"))
    cases = json.loads((ROOT / "web" / "cases.json").read_text(encoding="utf-8"))["cases"]
    with sync_playwright() as p:
        ctx = launch(p)
        page = open_page(ctx, "lab.html", "() => window.__lab")
        print("model:", run_job(page, "async ({ v, b }) => window.__lab.load(v, b)", {"v": VARIANT, "b": BACKEND}))
        res = run_job(page, "async ({ cases, e, q }) => window.__lab.probe(cases, e, q)", {"cases": cases, "e": qs["event"], "q": qs["pair"]})
        write(opt("--out", str(ROOT / ".cache" / "probe.json")), {"questions": qs, "result": res})
        ctx.close()
elif cmd == "js":
    body = Path(args[1]).read_text(encoding="utf-8")
    with sync_playwright() as p:
        ctx = launch(p)
        page = open_page(ctx, opt("--page", "lab.html"), "() => document.readyState === 'complete'")
        res = run_job(page, "async (arg) => {\n" + body + "\n}", None, "() => JSON.stringify(window.__progress ?? '')", 15)
        print(json.dumps(res, indent=1)[:4000])
        if opt("--out"):
            write(opt("--out"), res)
        ctx.close()
else:
    print(__doc__)
