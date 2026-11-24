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
const port = server.address().port;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });
const m = await page.evaluate(() => {
  const v = window.view;
  const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  return { bar: r(v.barEl), rail: r(v.railEl), scroll: r(v.scrollEl), page: r(v.pages[0].frame), tools: v.railEl.children.length, opts: r(v.optsEl) };
});
console.log(JSON.stringify(m));
await page.evaluate(() => window.view.setScale(2.6));
await new Promise((r) => setTimeout(r, 900));
const m2 = await page.evaluate(() => {
  const v = window.view;
  const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)]; };
  return { page: r(v.pages[0].frame), scrollLeft: v.scrollEl.scrollLeft, scrollW: v.scrollEl.scrollWidth, clientW: v.scrollEl.clientWidth };
});
console.log(JSON.stringify(m2));
await page.screenshot({ path: "test/shot-zoom.png" });
await browser.close(); server.close();
