// probe12: 设置页 —— 确认新增开关存在、默认关闭、能真正写回设置
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
await page.setViewport({ width: 820, height: 900 });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?file=sample.pdf`);
await page.waitForFunction(() => window.view?.pages?.[0]?.rendered, { timeout: 30000 });

const found = await page.evaluate(() => {
  document.querySelectorAll(".pdfann-opts, .pdfann-main").forEach((el) => (el.style.display = "none"));
  const tab = window.openSettings();
  // 只留设置页，方便截图核对
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
  const items = Array.from(tab.containerEl.querySelectorAll(".setting-item")).map((el) => ({
    name: el.querySelector(".setting-item-name")?.textContent || "",
    checked: el.querySelector("input[type=checkbox]") ? el.querySelector("input[type=checkbox]").checked : null,
  }));
  const hit = items.find((i) => i.name.includes("按住已有笔迹"));
  return { items, hit, setting: window.view.settings.penDragInk };
});
console.log("设置项数量:", found.items.length);
for (const i of found.items) if (i.name) console.log(`  ${i.checked === null ? "·" : i.checked ? "[x]" : "[ ]"} ${i.name}`);
console.log("penDragInk 默认:", found.setting);

const toggled = await page.evaluate(async () => {
  const rows = Array.from(document.querySelectorAll(".setting-item"));
  const row = rows.find((el) => (el.querySelector(".setting-item-name")?.textContent || "").includes("按住已有笔迹"));
  const box = row.querySelector("input[type=checkbox]");
  box.click();
  await new Promise((r) => setTimeout(r, 120));
  return { checked: box.checked, setting: window.view.settings.penDragInk };
});
console.log("点击后:", toggled);

const ok = !!found.hit && found.hit.checked === false && found.setting === false && toggled.checked === true && toggled.setting === true;
console.log(ok ? "PASS 开关存在、默认关闭、点击后写入设置" : "FAIL 开关有问题");

await page.screenshot({ path: "test/shot-settings.png" });
await browser.close();
server.close();
