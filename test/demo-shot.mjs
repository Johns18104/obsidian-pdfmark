// demo-shot: 生成一张用于 README / 插件市场的演示截图
// PDF 正文由本项目自行撰写，不含任何第三方版权内容
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";
import http from "http";
import puppeteer from "puppeteer-core";

const DIR = path.resolve("test/harness");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const PARAS = [
  ["Reading on Paper, Thinking in Ink", 19, 34],
  [
    "A margin is a small piece of land that belongs to the reader. What we write there is not the",
    12,
    20,
  ],
  [
    "book speaking; it is the conversation we have with the book while it is still open. That is why",
    12,
    18,
  ],
  [
    "a good reading tool should stay quiet: it marks, it remembers, and then it gets out of the way.",
    12,
    26,
  ],
  ["Three habits worth keeping", 14, 26],
  [
    "1. Mark less. One line that changed your mind is worth more than twenty lines you skimmed.",
    12,
    18,
  ],
  [
    "2. Name the idea, not the page. A note that says why beats a note that says where.",
    12,
    18,
  ],
  [
    "3. Come back once. A second visit turns a highlight into a thought; a third turns it into work.",
    12,
    26,
  ],
  [
    "The page remembers where you stopped, so the cost of returning is almost zero. Ink, marks and",
    12,
    18,
  ],
  [
    "shapes live next to the text they belong to, and they survive export: a note in Markdown for",
    12,
    18,
  ],
  [
    "the vault, and a flattened copy of the PDF for everyone who does not have this plugin.",
    12,
    18,
  ],
];

async function makeDemo() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const page = doc.addPage([595, 842]);
  let y = 760;
  for (const [line, size, gap] of PARAS) {
    if (line) {
      page.drawText(line, {
        x: 72,
        y,
        size,
        font: size > 13 ? bold : font,
        color: rgb(0.12, 0.12, 0.13),
      });
    }
    y -= gap;
  }
  fs.writeFileSync(path.join(DIR, "demo.pdf"), await doc.save());
}

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

await makeDemo();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?file=demo.pdf`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });

// 选中第 3 段中间的一句，高亮
const target = await page.evaluate(async () => {
  const v = window.view;
  const pe = v.pages[0];
  const items = await v.getItems(pe);
  const lay = pe.layout || (pe.layout = window.__buildLayout(items));
  const cells = lay.cells.filter((c) => c.ch && c.ch.trim());
  // 找包含 "quiet" 的那一行，取整行
  const idx = cells.findIndex((c) => /q/.test(c.ch) && lay.cells.indexOf(c) > 0);
  const lineNo = cells[Math.min(idx, cells.length - 1)]?.line ?? 0;
  const line = cells.filter((c) => c.line === lineNo);
  const a = line[0];
  const b = line[line.length - 1];
  const box = pe.inner.getBoundingClientRect();
  const f = (x, y) => {
    const p = pe.viewport.convertToViewportPoint(x, y);
    return [box.left + (Array.isArray(p) ? p[0] : p.x), box.top + (Array.isArray(p) ? p[1] : p.y)];
  };
  const p0 = f(a.rect.x + 2, a.rect.y + a.rect.h / 2);
  const p1 = f(b.rect.x + b.rect.w - 2, b.rect.y + b.rect.h / 2);
  return { p0, p1 };
});
await page.mouse.move(target.p0[0], target.p0[1]);
await page.mouse.down();
await page.mouse.move(target.p1[0], target.p1[1], { steps: 12 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 300));
// 点“高亮”
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll(".pdfann-popup button"));
  const b = btns.find((x) => /高亮/.test(x.textContent || ""));
  if (b) b.click();
});
await new Promise((r) => setTimeout(r, 300));

// 画笔写一笔
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll(".pdfann-tool")).find((x) => /画笔/.test(x.textContent || ""));
  if (el) el.click();
});
const anchors = await page.evaluate(async () => {
  const v = window.view;
  const pe = v.pages[0];
  const items = await v.getItems(pe);
  const lay = pe.layout || (pe.layout = window.__buildLayout(items));
  const box = pe.inner.getBoundingClientRect();
  const f = (x, y) => {
    const p = pe.viewport.convertToViewportPoint(x, y);
    return [box.left + (Array.isArray(p) ? p[0] : p.x), box.top + (Array.isArray(p) ? p[1] : p.y)];
  };
  const cells = lay.cells.filter((c) => c.ch && c.ch.trim());
  const item = (needle) => items.find((i) => i.str.includes(needle)) || items[0];
  const inkItem = item("Come back once").bbox;
  const headItem = item("Three habits").bbox;
  return {
    ink: [
      f(inkItem.x + 4, inkItem.y - 3),
      f(inkItem.x + 70, inkItem.y - 9),
      f(inkItem.x + 140, inkItem.y - 2),
      f(inkItem.x + 210, inkItem.y - 8),
    ],
    arrow: [f(headItem.x + headItem.w + 150, headItem.y + 48), f(headItem.x + headItem.w + 10, headItem.y + 8)],
  };
});
const pen = async (pts) => {
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p[0], p[1], { steps: 4 });
  await page.mouse.up();
};
await pen(anchors.ink);
await new Promise((r) => setTimeout(r, 200));

// 箭头
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll(".pdfann-tool")).find((x) => /箭头/.test(x.textContent || ""));
  if (el) el.click();
});
await pen(anchors.arrow);
await new Promise((r) => setTimeout(r, 250));
// 回到选择工具，让工具栏看起来正常
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll(".pdfann-tool")).find((x) => /选字/.test(x.textContent || ""));
  if (el) el.click();
});
await new Promise((r) => setTimeout(r, 400));

// 便签 + 文字批注（直接写入批注数据，便于稳定复现）
await page.evaluate(() => {
  const v = window.view;
  const now = Date.now();
  window.store.add(v.file.path, {
    id: "demo-note",
    page: 1,
    type: "note",
    color: "#f2c200",
    pt: { x: 300, y: 214 },
    text: "这一句值得回来看一遍。",
    created: now,
    updated: now,
  });
  window.store.add(v.file.path, {
    id: "demo-text",
    page: 1,
    type: "textbox",
    color: "#1f2430",
    size: 11,
    pt: { x: 90, y: 150 },
    w: 190,
    text: "读第二遍的时候，把这一条和自己正在做的事对上。",
    bg: null,
    created: now,
    updated: now,
  });
  v.paintPage(v.pages[0]);
  v.renderSidebar();
});
await new Promise((r) => setTimeout(r, 500));

fs.mkdirSync("images", { recursive: true });
await page.screenshot({ path: "images/screenshot-1.png" });
console.log("shot -> images/screenshot-1.png");

// 第二张：滚到底部，展示便签与文字批注
await page.evaluate(() => {
  const sc = window.view.scrollEl;
  sc.scrollTop = sc.scrollHeight;
});
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: "images/screenshot-2.png" });
console.log("shot -> images/screenshot-2.png");
await browser.close();
server.close();
