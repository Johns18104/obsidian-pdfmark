import fs from "fs"; import path from "path"; import http from "http"; import puppeteer from "puppeteer-core";
import { build } from "esbuild";
const DIR = path.resolve("test/harness");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".pdf": "application/pdf" };
fs.copyFileSync("styles.css", path.join(DIR, "styles.css"));
await build({ entryPoints: [path.join(DIR, "entry.ts")], bundle: true, format: "iife", target: "chrome110",
  outfile: path.join(DIR, "bundle.js"), alias: { obsidian: path.join(DIR, "obsidian.ts") }, logLevel: "error" });
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
await page.setViewport({ width: 1100, height: 1000 });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?file=cjk.pdf`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });

const info = await page.evaluate(async () => {
  const v = window.view, pe = v.pages[0];
  const items = await v.getItems(pe);
  const lay = pe.layout || (pe.layout = window.__buildLayout(items));
  return {
    items: items.slice(0, 6).map((i) => ({ str: i.str.slice(0, 30), n: i.str.length, x: +i.bbox.x.toFixed(1), y: +i.bbox.y.toFixed(1), w: +i.bbox.w.toFixed(1), h: +i.bbox.h.toFixed(1) })),
    cells: lay.cells.slice(0, 12).map((c) => ({ ch: c.ch, x: +c.rect.x.toFixed(1), w: +c.rect.w.toFixed(1), line: c.line })),
    lines: lay.lines.slice(0, 3),
    scale: v.scale,
  };
}).catch(async (e) => ({ err: String(e) }));
console.log(JSON.stringify(info, null, 1).slice(0, 2000));

// glyph ink columns from the rendered canvas, first text line
const ink = await page.evaluate(() => {
  const pe = window.view.pages[0];
  const c = pe.canvas;
  const ctx = c.getContext("2d");
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const W = c.width, H = c.height;
  const cols = new Array(W).fill(0);
  const rows = new Array(H).fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) { cols[x]++; rows[y]++; }
    }
  }
  // first band of rows with ink
  let y0 = 0; while (y0 < H && rows[y0] === 0) y0++;
  let y1 = y0; while (y1 < H && rows[y1] > 0) y1++;
  const runs = [];
  let inr = false, st = 0;
  for (let x = 0; x < W; x++) {
    let any = false;
    for (let y = y0; y < y1; y++) { const i = (y * W + x) * 4; if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) { any = true; break; } }
    if (any && !inr) { st = x; inr = true; } else if (!any && inr) { runs.push([st, x - 1]); inr = false; }
  }
  return { y0, y1, runs: runs.slice(0, 24), dpr: pe.canvas.width / pe.canvas.clientWidth };
});
console.log("ink rows", ink.y0, ink.y1, "dpr", ink.dpr);
console.log("ink runs:", JSON.stringify(ink.runs));
await page.screenshot({ path: "test/shot-cjk.png" });
await browser.close(); server.close();
