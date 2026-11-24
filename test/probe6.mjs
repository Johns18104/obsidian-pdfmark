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

const geo = await page.evaluate(() => {
  const v = window.view, pe = v.pages[0];
  const r = pe.inner.getBoundingClientRect();
  const fx = (p) => (Array.isArray(p) ? p[0] : p.x);
  const fy = (p) => (Array.isArray(p) ? p[1] : p.y);
  return v.getItems(pe).then((items) => {
    const it = items.find((i) => i.str.includes("quick brown"));
    const b = it.bbox;
    const at = (fxr) => {
      const p = pe.viewport.convertToViewportPoint(b.x + b.w * fxr, b.y + b.h / 2);
      return { x: r.left + fx(p), y: r.top + fy(p) };
    };
    return { str: it.str, a: at(0.28), b: at(0.62), full: it.bbox.w };
  });
});
console.log("line:", JSON.stringify(geo.str));

// partial drag from 28% to 62% of the line
await page.mouse.move(geo.a.x, geo.a.y);
await page.mouse.down();
await page.mouse.move((geo.a.x + geo.b.x) / 2, geo.a.y, { steps: 5 });
await page.mouse.move(geo.b.x, geo.b.y, { steps: 5 });
const preview = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll(".pdfann-selrect"));
  return els.map((e) => [Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().width)]);
});
await page.mouse.up();
await new Promise((r) => setTimeout(r, 250));
console.log("preview rects during drag:", JSON.stringify(preview));
const popupText = await page.evaluate(() => {
  const el = document.querySelector(".pdfann-popup");
  return el ? el.innerText.replace(/\n/g, "|") : null;
});
console.log("popup:", popupText);

// pick 高亮
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll(".pdfann-popup button")).find((x) => x.textContent.trim() === "高亮");
  b && b.click();
});
await new Promise((r) => setTimeout(r, 200));
const res = await page.evaluate(() => {
  const v = window.view;
  const a = v.store.annotsOf(v.file.path, 1).filter((x) => x.type === "highlight");
  const it = a[a.length - 1];
  return { n: a.length, text: it && it.text, rects: it && it.rects.map((r) => ({ x: +r.x.toFixed(1), w: +r.w.toFixed(1) })) };
});
console.log("annots:", JSON.stringify(res));

// double click selects one word
const dbl = await page.evaluate(() => {
  const v = window.view, pe = v.pages[0];
  const r = pe.inner.getBoundingClientRect();
  const fx = (p) => (Array.isArray(p) ? p[0] : p.x);
  const fy = (p) => (Array.isArray(p) ? p[1] : p.y);
  return v.getItems(pe).then((items) => {
    const it = items.find((i) => i.str.includes("quick brown"));
    const p = pe.viewport.convertToViewportPoint(it.bbox.x + it.bbox.w * 0.45, it.bbox.y + it.bbox.h / 2);
    return { x: r.left + fx(p), y: r.top + fy(p) };
  });
});
await page.mouse.click(dbl.x, dbl.y);
await page.mouse.click(dbl.x, dbl.y, { clickCount: 2 });
await new Promise((r) => setTimeout(r, 250));
const dblText = await page.evaluate(() => {
  const els = document.querySelectorAll(".pdfann-selrect");
  const pop = document.querySelector(".pdfann-popup");
  return { rects: els.length, left: els[0] ? Math.round(els[0].getBoundingClientRect().left) : null, w: els[0] ? Math.round(els[0].getBoundingClientRect().width) : null, popup: pop ? pop.innerText.replace(/\n/g, "|") : null };
});
console.log("double click:", JSON.stringify(dblText), "full line width px:", Math.round(geo.full));
await page.screenshot({ path: "test/shot-select.png" });
await browser.close(); server.close();
