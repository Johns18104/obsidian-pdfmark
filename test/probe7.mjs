import fs from "fs"; import path from "path"; import http from "http"; import puppeteer from "puppeteer-core";
const DIR = path.resolve("test/harness");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".pdf": "application/pdf" };
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const file = path.join(DIR, url === "/" ? "index.html" : url);
  if (!file.startsWith(DIR) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });

const out = await page.evaluate(async () => {
  const v = window.view, pe = v.pages[0];
  const items = await v.getItems(pe);
  const lines = items.map((i) => ({ str: i.str.slice(0, 26), y: +i.bbox.y.toFixed(1), x: +i.bbox.x.toFixed(1), w: +i.bbox.w.toFixed(1), h: +i.bbox.h.toFixed(1) }));
  const r = pe.inner.getBoundingClientRect();
  const fx = (p) => (Array.isArray(p) ? p[0] : p.x);
  const fy = (p) => (Array.isArray(p) ? p[1] : p.y);
  const a = items.find((i) => i.str.includes("quick brown"));
  const b = items.find((i) => i.str.includes("lazy dog"));
  const at = (it, k) => {
    const p = pe.viewport.convertToViewportPoint(it.bbox.x + it.bbox.w * k, it.bbox.y + it.bbox.h / 2);
    return { x: r.left + fx(p), y: r.top + fy(p), raw: { x: it.bbox.x + it.bbox.w * k, y: it.bbox.y + it.bbox.h / 2 } };
  };
  return { lines, A: at(a, 0.55), B: at(b, 0.35), rect: [r.left, r.top, r.width, r.height], vp: pe.viewport.height };
});
console.log(JSON.stringify(out, null, 1).slice(0, 1600));
await browser.close(); server.close();
