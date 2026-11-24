import { build } from "esbuild";
import fs from "fs";
import path from "path";
import http from "http";
import puppeteer from "puppeteer-core";

const DIR = path.resolve("test/harness");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function bundle() {
  fs.copyFileSync("styles.css", path.join(DIR, "styles.css"));
  await build({
    entryPoints: [path.join(DIR, "entry.ts")],
    bundle: true, format: "iife", target: "chrome110",
    outfile: path.join(DIR, "bundle.js"),
    alias: { obsidian: path.join(DIR, "obsidian.ts") },
    logLevel: "error",
  });
}

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
page.on("console", (m) => console.log("[page]", m.type(), m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => window.ready === true || window.bootError, { timeout: 30000 });
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });

const info = await page.evaluate(() => {
  const v = window.view, pe = v.pages[0];
  window.__ev = { down: 0, move: 0, docMove: 0, up: 0, secDown: 0, paint: [] };
  pe.draw.addEventListener("pointerdown", (e) => { __ev.down++; __ev.secDown = e.pointerId; });
  pe.draw.addEventListener("pointermove", () => __ev.move++);
  document.addEventListener("pointermove", () => __ev.docMove++);
  pe.draw.addEventListener("pointerup", () => __ev.up++);
  return { tool: v.tool, hasViewport: !!pe.viewport, scale: v.scale };
});
console.log("init:", JSON.stringify(info));

const r = await page.evaluate(() => { const b = window.view.pages[0].inner.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; });
const cx = r.l + r.w / 2, cy = r.t + 300;
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 15, cy + i * 4);
await page.mouse.up();
await new Promise((res) => setTimeout(res, 300));

const after = await page.evaluate(() => {
  const v = window.view;
  const a = v.store.annotsOf(v.file.path, 1);
  return { ev: __ev, annots: a.map((x) => ({ type: x.type, strokes: x.strokes ? x.strokes.map((s) => s.length) : null })), tool: v.tool };
});
console.log("after:", JSON.stringify(after));

await browser.close(); server.close();
