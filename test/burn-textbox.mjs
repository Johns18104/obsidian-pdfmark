// 验证：便签与文字批注烧入 PDF 后，文字仍然看得见（不是只剩一个图标、也不是空白）
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
await page.setViewport({ width: 1180, height: 820, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?file=demo.pdf`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });

const res = await page.evaluate(async () => {
  const now = Date.now();
  const annots = [
    {
      id: "note1",
      page: 1,
      type: "note",
      color: "#f2c200",
      pt: { x: 330, y: 250 },
      text: "便签内容：这里需要一个例子，中文和 English 混排。The note text must survive burning.",
      created: now,
      updated: now,
    },
    {
      id: "tb1",
      page: 1,
      type: "textbox",
      color: "#1f2430",
      size: 12,
      pt: { x: 90, y: 200 },
      w: 200,
      text: "文字批注（直接写在页面上）\nSecond line in English, wraps automatically.",
      bg: null,
      created: now,
      updated: now,
    },
  ];
  const burned = await window.__burn(window.view.pdfBytes, annots);
  let bin = "";
  for (let i = 0; i < burned.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, burned.slice(i, i + 0x8000));
  }
  return { b64: btoa(bin), images: (burned.length && new TextDecoder("latin1").decode(burned).match(/\/Subtype\s*\/Image/g) || []).length };
});

const out = path.join(DIR, "burned-notes.pdf");
fs.writeFileSync(out, Buffer.from(res.b64, "base64"));
console.log("burned ->", out, fs.statSync(out).size, "bytes, 图片对象:", res.images);

// 用同一个渲染器打开烧入后的文件，检查文字是否可见
const page2 = await browser.newPage();
await page2.setViewport({ width: 1180, height: 820, deviceScaleFactor: 2 });
await page2.goto(`http://127.0.0.1:${server.address().port}/index.html?file=burned-notes.pdf`);
await page2.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });
await page2.evaluate(() => {
  const v = window.view;
  v.pages[0].inner.scrollIntoView({ block: "center" });
});
await new Promise((r) => setTimeout(r, 600));
await page2.screenshot({ path: "test/burned-notes.png" });

// 烧入后的页面里有两块图片（便签文字块 + 文字批注块）
const inkPixels = await page2.evaluate(() => {
  const pe = window.view.pages[0];
  const c = pe.canvas;
  const ctx = c.getContext("2d");
  const img = ctx.getImageData(0, Math.round(c.height * 0.55), c.width, Math.round(c.height * 0.4)).data;
  let dark = 0;
  for (let i = 0; i < img.length; i += 4) if (img[i] < 90 && img[i + 1] < 90) dark++;
  return dark;
});
console.log("底部区域深色像素:", inkPixels);
console.log(res.images >= 2 && inkPixels > 500 ? "PASS 烧入后文字可见" : "FAIL 烧入后文字丢失");
await browser.close();
server.close();
