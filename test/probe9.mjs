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
await page.setViewport({ width: 1100, height: 1000 });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?file=cjk.pdf`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });

// click exactly on the centre of the 4th character of line 1 and see what gets selected
const r = await page.evaluate(async () => {
  const v = window.view, pe = v.pages[0];
  const items = await v.getItems(pe);
  const lay = pe.layout || (pe.layout = window.__buildLayout(items));
  const cell = lay.cells[3];
  const box = pe.inner.getBoundingClientRect();
  const fx = (p) => (Array.isArray(p) ? p[0] : p.x);
  const fy = (p) => (Array.isArray(p) ? p[1] : p.y);
  const mid = pe.viewport.convertToViewportPoint(cell.rect.x + cell.rect.w / 2, cell.rect.y + cell.rect.h / 2);
  return { ch: cell.ch, x: box.left + fx(mid), y: box.top + fy(mid), cellRect: cell.rect };
});
await page.mouse.move(r.x, r.y);
await page.mouse.down();
await page.mouse.move(r.x + 40, r.y, { steps: 4 });
await page.mouse.up();
await new Promise((res) => setTimeout(res, 250));
const sel = await page.evaluate(() => ({
  snippet: document.querySelector(".pdfann-popup-text")?.textContent || null,
  rect: (() => { const e = document.querySelector(".pdfann-selrect"); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)]; })(),
}));
console.log("clicked char:", r.ch, "cell x=", r.cellRect.x.toFixed(1), "w=", r.cellRect.w.toFixed(1));
console.log("selected:", JSON.stringify(sel));
await page.screenshot({ path: "test/shot-cjk-sel.png" });
await browser.close(); server.close();
