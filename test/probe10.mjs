// probe10: 市场安装等价环境 —— 只有 main.js/styles.css，没有 cmaps/ 与 standard_fonts/
// 验证：中文 PDF 的文字层仍然可提取、没有资源 404、没有 CMap 报错
import fs from "fs";
import path from "path";
import http from "http";
import puppeteer from "puppeteer-core";

const DIR = path.resolve("test/harness");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".pdf": "application/pdf" };
const missing = [];
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const file = path.join(DIR, url === "/" ? "index.html" : url);
  if (!file.startsWith(DIR) || !fs.existsSync(file)) {
    missing.push(url);
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
const warns = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") warns.push(m.text());
});
page.on("pageerror", (e) => warns.push("pageerror: " + e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?file=cjk.pdf`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });

const out = await page.evaluate(async () => {
  const v = window.view;
  const pe = v.pages[0];
  const items = await v.getItems(pe);
  const text = items.map((i) => i.str).join("");
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  return { items: items.length, cjk, sample: text.slice(0, 40) };
});

console.log("items:", out.items, "中文字符数:", out.cjk, "sample:", JSON.stringify(out.sample));
console.log("404 请求:", missing.length ? missing : "无");
console.log("控制台告警:", warns.filter((w) => !/Failed to load resource/.test(w)).slice(0, 5));
const ok = out.cjk >= 4 && !missing.some((u) => /cmap|standard_font/i.test(u));
console.log(ok ? "PASS 无外部资源依赖，中文文字层可用" : "FAIL 仍依赖外部资源");
await page.screenshot({ path: "test/shot-cjk-store.png" });
await browser.close();
server.close();
