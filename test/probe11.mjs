// probe11: 字号 —— 便签与文字批注在同一页上从小到大各来一个，肉眼核对渲染
import fs from "fs";
import path from "path";
import http from "http";
import puppeteer from "puppeteer-core";

const DIR = path.resolve("test/harness");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".pdf": "application/pdf" };
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const file = path.join(DIR, url === "/" ? "index.html" : url);
  if (!file.startsWith(DIR) || !fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 1000 });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?file=sample.pdf`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });

const info = await page.evaluate(() => {
  const v = window.view;
  const now = Date.now();
  const add = (a) => window.store.add(v.file.path, a);
  add({
    id: "p11-note-11",
    page: 1,
    type: "note",
    color: "#f2c200",
    pt: { x: 60, y: 700 },
    text: "11pt 便签：字号小的时候长这样。",
    size: 11,
    created: now,
    updated: now,
  });
  add({
    id: "p11-note-20",
    page: 1,
    type: "note",
    color: "#f2c200",
    pt: { x: 60, y: 640 },
    text: "20pt 便签：字号大的时候长这样。",
    size: 20,
    created: now,
    updated: now,
  });
  add({
    id: "p11-box-12",
    page: 1,
    type: "textbox",
    color: "#e8453c",
    size: 12,
    pt: { x: 60, y: 560 },
    w: 220,
    text: "12pt 文字批注：The quick brown fox",
    bg: null,
    created: now,
    updated: now,
  });
  add({
    id: "p11-box-24",
    page: 1,
    type: "textbox",
    color: "#2f7fd8",
    size: 24,
    pt: { x: 60, y: 470 },
    w: 260,
    text: "24pt 文字批注：明显变大",
    bg: null,
    created: now,
    updated: now,
  });
  v.paintPage(v.pages[0]);
  const fill = Array.from(document.querySelectorAll(".pdfann-textcard text")).map((t) => ({
    size: Math.round(Number(t.getAttribute("font-size"))),
    fill: t.getAttribute("fill"),
    text: (t.textContent || "").slice(0, 12),
  }));
  return { fill, scale: Math.round(v.scale * 100) / 100 };
});
console.log("scale:", info.scale);
for (const f of info.fill) console.log(`  ${f.size}px  ${f.fill}  ${f.text}`);

const okSizes = info.fill.some((f) => f.text.startsWith("11pt") && Math.abs(f.size - 11 * info.scale) < 1.5) &&
  info.fill.some((f) => f.text.startsWith("20pt") && Math.abs(f.size - 20 * info.scale) < 1.5) &&
  info.fill.some((f) => f.text.startsWith("12pt") && Math.abs(f.size - 12 * info.scale) < 1.5) &&
  info.fill.some((f) => f.text.startsWith("24pt") && Math.abs(f.size - 24 * info.scale) < 1.5);
const okColors = info.fill.filter((f) => /便签/.test(f.text)).every((f) => f.fill === "#1f2430");
console.log(okSizes ? "PASS 四张卡片的字号与设定一致" : "FAIL 字号不符");
console.log(okColors ? "PASS 便签正文是深色字" : "FAIL 便签正文仍在用图钉颜色");

const box = await page.evaluate(() => {
  const r = window.view.pages[0].inner.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
await page.screenshot({
  path: "test/shot-fontsize.png",
  clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y), width: Math.min(box.w + 20, 900), height: Math.min(box.h, 950) },
});
await browser.close();
server.close();
