import puppeteer from "puppeteer-core";
import fs from "fs";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body { font-family: "Songti SC", "PingFang SC", serif; font-size: 16pt; line-height: 1.9; margin: 60px 70px; color:#111; text-align: justify; }
p { text-indent: 2em; margin: 0 0 10px; }
</style></head><body>
<p>须升级换代，面临着从知识培养和灌输的模式走出来的挑战。教育兴则民族兴。《教育部关于加快建设高水平本科教育全面提高人才培养能力的意见》（教高〔2018〕2号，以下简称《意见》）明确指出，要建设高水平本科教育。</p>
<p>English mixed 中文 text with numbers 2018 and punctuation, 用于观察混排时的字符边界是否准确。</p>
</body></html>`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "load" });
const buf = await page.pdf({ format: "A4", printBackground: true });
fs.writeFileSync("test/harness/cjk.pdf", buf);
console.log("cjk.pdf", buf.length);
await browser.close();
