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

const out = await page.evaluate(() => {
  const v = window.view, pe = v.pages[0];
  const vp = pe.viewport;
  const vt = (x, y) => { const p = vp.convertToViewportPoint(x, y); return { x: p.x, y: p.y, xx: p[0], yy: p[1] }; };
  const pd = (x, y) => { const p = vp.convertToPdfPoint(x, y); return { x: p.x, y: p.y, xx: p[0], yy: p[1] }; };
  return {
    keys: Object.keys(vp),
    transform: vp.transform,
    scale: vp.scale,
    width: vp.width,
    height: vp.height,
    vt100: vt(100, 100),
    pd100: pd(100, 100),
    fnNames: Object.getOwnPropertyNames(Object.getPrototypeOf(vp)),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
