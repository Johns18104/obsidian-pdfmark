import fs from "fs";
import path from "path";
import http from "http";
import puppeteer from "puppeteer-core";

const DIR = path.resolve("test/harness");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function serve() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".pdf": "application/pdf" };
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const file = path.join(DIR, url === "/" ? "index.html" : url);
    if (!file.startsWith(DIR) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const server = await serve();
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });

await page.evaluate(() => {
  const v = window.view, pe = v.pages[0];
  window.__co = [];
  pe.draw.addEventListener("pointermove", (e) => {
    const c = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    __co.push({ n: c ? c.length : -1, cx: e.clientX, trusted: e.isTrusted });
  });
});
const r = await page.evaluate(() => { const b = window.view.pages[0].inner.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; });

await page.evaluate(() => document.querySelector('.pdfann-tool[data-tool="pen"]').click());
const cx = r.l + r.w / 2, cy = r.t + 300;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 15, cy + i * 4);
await page.mouse.up();
await new Promise((res) => setTimeout(res, 300));

const out = await page.evaluate(() => {
  const v = window.view, pe = v.pages[0];
  const a = v.store.annotsOf(v.file.path, 1);
  const c = pe.ink;
  const ctx = c.getContext("2d");
  const count = () => { const d = ctx.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++; return n; };
  const before = count();
  const t = ctx.getTransform();
  v.paintPage(pe);
  const afterRepaint = count();
  return {
    annots: a.map((x) => ({ type: x.type, pts: x.strokes ? x.strokes.map((s) => s.length) : null, w: x.width, color: x.color })),
    canvas: { w: c.width, h: c.height, cw: c.style.width, ch: c.style.height },
    transform: [t.a, t.b, t.c, t.d, t.e, t.f],
    before, afterRepaint,
    coalesced: __co.slice(0, 4),
    coLen: __co.length,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
