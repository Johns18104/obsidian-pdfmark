// probe13: 英文界面 —— 工具栏不挤、设置页可读
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
await page.setViewport({ width: 1200, height: 900 });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?file=sample.pdf&lang=en`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });

const info = await page.evaluate(() => {
  const v = window.view;
  const now = Date.now();
  v.store.add(v.file.path, {
    id: "en-hl",
    page: 1,
    type: "highlight",
    color: "#ffe066",
    rects: [{ x: 60, y: 690, w: 220, h: 14 }],
    text: "sample highlight",
    created: now,
    updated: now,
  });
  v.store.add(v.file.path, {
    id: "en-note",
    page: 1,
    type: "note",
    color: "#f2c200",
    pt: { x: 320, y: 700 },
    text: "A note with body text, 11 pt.",
    size: 11,
    created: now,
    updated: now,
  });
  v.paintPage(v.pages[0]);
  v.renderSidebar();
  const btns = Array.from(document.querySelectorAll(".pdfann-tool")).map((b) => {
    const label = b.querySelector(".pdfann-tool-label");
    const r = label.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return {
      text: label.textContent,
      labelW: Math.round(r.width),
      btnW: Math.round(br.width),
      overflows: r.width > br.width + 0.5,
    };
  });
  return {
    btns,
    opts: document.querySelector(".pdfann-opts-label")?.textContent,
    sidebar: Array.from(document.querySelectorAll(".pdfann-tab")).map((e) => e.textContent),
    head: document.querySelector(".pdfann-side-head span")?.textContent,
  };
});
console.log("options label:", JSON.stringify(info.opts));
console.log("sidebar tabs:", info.sidebar, "head:", info.head);
const wide = info.btns.filter((b) => b.overflows);
for (const b of info.btns) console.log(`  ${b.overflows ? "!" : " "} ${b.text.padEnd(12)} label ${b.labelW}px / button ${b.btnW}px`);
console.log(wide.length ? `FAIL ${wide.length} 个标签超出按钮宽度` : "PASS 所有英文标签都在按钮内");

await page.screenshot({ path: "test/shot-en.png" });

// 英文设置页截图
await page.evaluate(() => {
  const tab = window.openSettings();
  const el = tab.containerEl;
  document.body.innerHTML = "";
  document.body.appendChild(el);
  Object.assign(el.style, { padding: "18px 22px", font: "14px/1.6 -apple-system, system-ui, sans-serif", maxWidth: "760px" });
  el.querySelectorAll(".setting-item").forEach((row) => {
    Object.assign(row.style, { padding: "10px 0", borderBottom: "1px solid #e6e6e6" });
    const n = row.querySelector(".setting-item-name");
    if (n) n.style.fontWeight = "600";
    const d = row.querySelector(".setting-item-description");
    if (d) Object.assign(d.style, { color: "#666", fontSize: "12.5px" });
  });
});
await page.screenshot({ path: "test/shot-settings-en.png" });
await browser.close();
server.close();
