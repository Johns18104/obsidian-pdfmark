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
await page.setViewport({ width: 1280, height: 800 });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });
const m = await page.evaluate(() => {
  const v = window.view;
  const rail = v.railEl.getBoundingClientRect();
  const kids = Array.from(v.railEl.children).map((el) => {
    const b = el.getBoundingClientRect();
    return { tag: el.tagName, tool: el.dataset.tool || el.className, y: Math.round(b.top), h: Math.round(b.height), x: Math.round(b.left), w: Math.round(b.width), html: el.innerHTML.slice(0, 40) };
  });
  return { rail: [Math.round(rail.left), Math.round(rail.top), Math.round(rail.width), Math.round(rail.height)], kids };
});
console.log(JSON.stringify(m, null, 1));
await browser.close(); server.close();
