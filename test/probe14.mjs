// probe14: 箭头形状专项 —— 屏幕上放大后不变形，烧入后与屏幕一致
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

const annots = [
  // 细 / 中 / 粗，横 / 斜 / 竖，一条超短（整条几乎只有箭头）
  { id: "a1", page: 1, type: "arrow", color: "#e8453c", width: 1.6, p0: { x: 80, y: 640 }, p1: { x: 300, y: 640 } },
  { id: "a2", page: 1, type: "arrow", color: "#2f7fd8", width: 6, p0: { x: 80, y: 580 }, p1: { x: 300, y: 580 } },
  { id: "a3", page: 1, type: "arrow", color: "#2f9e68", width: 13, p0: { x: 80, y: 500 }, p1: { x: 300, y: 500 } },
  { id: "a4", page: 1, type: "arrow", color: "#8e6fd8", width: 13, p0: { x: 120, y: 450 }, p1: { x: 300, y: 350 } },
  { id: "a5", page: 1, type: "arrow", color: "#f08c1a", width: 13, p0: { x: 320, y: 400 }, p1: { x: 320, y: 270 } },
  { id: "a6", page: 1, type: "arrow", color: "#1f2430", width: 13, p0: { x: 80, y: 230 }, p1: { x: 120, y: 230 } },
].map((a) => ({ ...a, created: 1, updated: 1 }));

async function open(file = "demo.pdf") {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`${base}?file=${file}`);
  await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 400));
  return page;
}

async function shot(file, name, zoom) {
  const page = await open(file);
  await page.evaluate(async (list) => {
    const v = window.view;
    for (const a of list) v.store.add(v.file.path, a);
    v.paintPage(v.pages[0]);
  }, annots);
  if (zoom) {
    await page.evaluate((z) => {
      const v = window.view;
      v.settings.defaultFitWidth = false; // 否则窗口一 resize 就被拉回“适应宽度”
      v.setScale(z);
    }, zoom);
    await new Promise((r) => setTimeout(r, 900));
  }
  await page.evaluate(() => {
    // 把箭头所在的那一带滚到视野里（y=560 附近，x=200 附近）
    const v = window.view;
    const pe = v.pages[0];
    const r = pe.inner.getBoundingClientRect();
    const p = pe.viewport.convertToViewportPoint(200, 560);
    const fx = Array.isArray(p) ? p[0] : p.x;
    const fy = Array.isArray(p) ? p[1] : p.y;
    const box = v.scrollEl.getBoundingClientRect();
    v.scrollEl.scrollTop += r.top + fy - (box.top + box.height * 0.45);
    v.scrollEl.scrollLeft += r.left + fx - (box.left + box.width * 0.45);
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: name, clip: { x: 0, y: 0, width: 880, height: 660 } });
  const scale = await page.evaluate(() => window.view.scale);
  await page.close();
  return scale;
}

console.log("1x scale:", (await shot("demo.pdf", "test/arrow-1x.png")).toFixed(2));
console.log("3x scale:", (await shot("demo.pdf", "test/arrow-3x.png", 3)).toFixed(2));

// 烧入成 PDF，再用同一渲染器打开并截图
const page = await open("demo.pdf");
const burned = await page.evaluate(async (list) => {
  const out = await window.__burn(window.view.pdfBytes, list);
  let bin = "";
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.slice(i, i + 0x8000));
  return btoa(bin);
}, annots);
fs.writeFileSync(path.join(DIR, "burned-arrows.pdf"), Buffer.from(burned, "base64"));
await page.close();

const page2 = await open("burned-arrows.pdf");
await page2.evaluate(() => window.view.pages[0].inner.scrollIntoView({ block: "start" }));
await new Promise((r) => setTimeout(r, 600));
await page2.screenshot({ path: "test/arrow-burned.png", clip: { x: 0, y: 0, width: 880, height: 660 } });

// 红色细箭头（y=640，箭尖 x=300）：箭尖后方应该有实心三角，箭尖前方不该有颜色
const probe = await page2.evaluate(() => {
  const pe = window.view.pages[0];
  const ctx = pe.canvas.getContext("2d");
  const cssW = parseFloat(pe.canvas.style.width) || pe.canvas.clientWidth;
  const dpr = pe.canvas.width / cssW;
  const get = (p) => {
    const q = pe.viewport.convertToViewportPoint(p.x, p.y);
    const x = Math.round((Array.isArray(q) ? q[0] : q.x) * dpr);
    const y = Math.round((Array.isArray(q) ? q[1] : q.y) * dpr);
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  };
  const red = (p) => {
    const c = get(p);
    return c.r > 140 && c.g < 130 && c.b < 130;
  };
  const scanX = (from, to, y) => {
    let n = 0;
    for (let x = from; x <= to; x += 0.25) if (red({ x, y })) n++;
    return n;
  };
  return {
    dpr,
    // 箭头三角内部（箭尖往后 1~4pt）
    inside: scanX(296, 299, 640),
    // 箭尖前方 1~10pt：旧版圆头会在这里冒出一块
    past: scanX(301, 310, 640),
    pastFar: scanX(311, 330, 640),
  };
});
console.log("burned red pixels:", JSON.stringify(probe));
console.log(
  probe.inside > 3 && probe.past === 0 && probe.pastFar === 0
    ? "PASS 烧入后箭头头部实心、箭尖外无溢出"
    : "FAIL 烧入后箭头形状异常"
);

await browser.close();
server.close();
