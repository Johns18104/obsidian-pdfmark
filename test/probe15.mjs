// probe15: 下划线 / 删除线粗细 2.5pt —— 屏幕、烧入后量出来的都是 2.5pt
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
const base = `http://127.0.0.1:${server.address().port}/index.html`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

async function open(file) {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`${base}?file=${file}`);
  await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 500));
  return page;
}

/** 用真实的文字行做标注，这样能看出横线和字的关系 */
const makeAnnots = async () => {
  const v = window.view;
  const items = await v.getItems(v.pages[0]);
  // 按视觉行分组（PDF 坐标 y 向上），取第 3、4 行
  const rows = items
    .slice()
    .sort((a, b) => b.bbox.y + b.bbox.h - (a.bbox.y + a.bbox.h))
    .reduce((acc, it) => {
      const last = acc[acc.length - 1];
      if (last && Math.abs(last[0].bbox.y - it.bbox.y) < Math.max(2, it.bbox.h * 0.5)) last.push(it);
      else acc.push([it]);
      return acc;
    }, []);
  const lineRect = (row) => {
    const x = Math.min(...row.map((i) => i.bbox.x));
    const right = Math.max(...row.map((i) => i.bbox.x + i.bbox.w));
    const y = Math.min(...row.map((i) => i.bbox.y));
    const h = Math.max(...row.map((i) => i.bbox.h));
    return { x, y, w: right - x, h };
  };
  return [
    { id: "u1", page: 1, type: "underline", color: "#e8453c", rects: [lineRect(rows[2])], text: "u" },
    { id: "s1", page: 1, type: "strike", color: "#2f7fd8", rects: [lineRect(rows[3])], text: "s" },
  ].map((a) => ({ ...a, created: 1, updated: 1 }));
};

const scrollTo = () => {
  const v = window.view;
  const el = v.pages[0].inner;
  const box = v.scrollEl.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const p = v.pages[0].viewport.convertToViewportPoint(100, 700);
  v.scrollEl.scrollTop += r.top + (Array.isArray(p) ? p[1] : p.y) - (box.top + box.height * 0.35);
};

// --- 屏幕 ---
const page = await open("demo.pdf");
const annots = await page.evaluate(makeAnnots);
await page.evaluate((list) => {
  const v = window.view;
  for (const a of list) v.store.add(v.file.path, a);
  v.paintPage(v.pages[0]);
}, annots);
await page.evaluate(scrollTo);
await new Promise((r) => setTimeout(r, 600));

const screen = await page.evaluate((list) => {
  // 标注画在 SVG 覆盖层上，不在 canvas 里：读属性再换算回 pt
  const v = window.view;
  const s = v.scale;
  const lines = Array.from(v.pages[0].svg.querySelectorAll("line"));
  const pt = (color) => {
    const el = lines.find((l) => l.getAttribute("stroke") === color);
    return el ? Number(el.getAttribute("stroke-width")) / s : null;
  };
  return { scale: s, underline: pt(list[0].color), strike: pt(list[1].color) };
}, annots);
await page.screenshot({ path: "test/rules-screen.png", clip: { x: 0, y: 0, width: 880, height: 620 } });
console.log("screen(attribute, pt):", JSON.stringify(screen));

// --- 烧入 ---
const out = await page.evaluate(async (list) => {
  const bytes = await window.__burn(window.view.pdfBytes, list);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.slice(i, i + 0x8000));
  return btoa(bin);
}, annots);
await page.close();
fs.writeFileSync(path.join(DIR, "burned-rules.pdf"), Buffer.from(out, "base64"));

const page2 = await open("burned-rules.pdf");
await page2.evaluate(scrollTo);
await new Promise((r) => setTimeout(r, 600));
await page2.screenshot({ path: "test/rules-burned.png", clip: { x: 0, y: 0, width: 880, height: 620 } });

const burned = await page2.evaluate((list) => {
  const pe = window.view.pages[0];
  const ctx = pe.canvas.getContext("2d");
  const cssW = parseFloat(pe.canvas.style.width) || pe.canvas.clientWidth;
  const dpr = pe.canvas.width / cssW;
  // 在横线中段竖着一列采样，量出线宽（pt）
  const thickness = (rect, match) => {
    let n = 0;
    const x = rect.x + rect.w * 0.5;
    for (let y = rect.y - 4; y <= rect.y + rect.h + 4; y += 0.125) {
      const q = pe.viewport.convertToViewportPoint(x, y);
      const c = ctx.getImageData(
        Math.round((Array.isArray(q) ? q[0] : q.x) * dpr),
        Math.round((Array.isArray(q) ? q[1] : q.y) * dpr),
        1,
        1
      ).data;
      if (match(c)) n++;
    }
    return n * 0.125;
  };
  const red = (c) => c[0] > 140 && c[1] < 130 && c[2] < 130;
  const blue = (c) => c[2] > 140 && c[0] < 130;
  return {
    scale: window.view.scale,
    dpr,
    underline: thickness(list[0].rects[0], red),
    strike: thickness(list[1].rects[0], blue),
  };
}, annots);
console.log("burned(pixels→pt):", JSON.stringify(burned));

// 再放大看一眼横线和字的位置关系
await page2.evaluate((list) => {
  const v = window.view;
  v.settings.defaultFitWidth = false;
  v.setScale(2.4);
}, annots);
await new Promise((r) => setTimeout(r, 1200));
await page2.evaluate((list) => {
  const v = window.view;
  const el = v.pages[0].inner;
  const box = v.scrollEl.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const q = v.pages[0].viewport.convertToViewportPoint(list[1].rects[0].x, list[1].rects[0].y);
  v.scrollEl.scrollTop += r.top + (Array.isArray(q) ? q[1] : q.y) - (box.top + box.height * 0.25);
  v.scrollEl.scrollLeft += r.left + (Array.isArray(q) ? q[0] : q.x) - (box.left + 40);
}, annots);
await new Promise((r) => setTimeout(r, 700));
await page2.screenshot({ path: "test/rules-zoom.png", clip: { x: 0, y: 0, width: 880, height: 400 } });

const ok = (v) => v !== null && Math.abs(v - 2.5) < 0.7;
console.log(
  ok(screen.underline) && ok(screen.strike) && ok(burned.underline) && ok(burned.strike)
    ? "PASS 下划线/删除线 2.5pt（屏幕与烧入一致）"
    : "FAIL 粗细不对"
);

await browser.close();
server.close();
