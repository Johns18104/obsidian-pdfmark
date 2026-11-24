import { build } from "esbuild";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";
import http from "http";
import puppeteer from "puppeteer-core";

const DIR = path.resolve("test/harness");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([595, 842]);
    for (let l = 0; l < 12; l++) {
      page.drawText(`Page ${i + 1} line ${l + 1}: The quick brown fox jumps over the lazy dog.`, {
        x: 60,
        y: 760 - l * 28,
        size: 13,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
    page.drawText("SELECT ME: exact target phrase", { x: 60, y: 300, size: 15, font, color: rgb(0, 0, 0) });
  }
  fs.writeFileSync(path.join(DIR, "sample.pdf"), await doc.save());
}

async function bundle() {
  fs.copyFileSync("styles.css", path.join(DIR, "styles.css"));
  await build({
    entryPoints: [path.join(DIR, "entry.ts")],
    bundle: true,
    format: "iife",
    target: "chrome110",
    outfile: path.join(DIR, "bundle.js"),
    alias: { obsidian: path.join(DIR, "obsidian.ts") },
    loader: { ".js": "js" },
    logLevel: "error",
    define: { "process.env.NODE_ENV": '"production"' },
  });
}

function serve() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".pdf": "application/pdf" };
  const server = http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const file = path.join(DIR, url === "/" ? "index.html" : url);
    if (!file.startsWith(DIR) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end("nope");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const log = [];
function report(name, ok, extra = "") {
  log.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
}

async function main() {
  await makePdf();
  await bundle();
  const server = await serve();
  const port = server.address().port;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--allow-file-access-from-files", "--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || m.type() === "warning") console.log(`   [page:${m.type()}] ${t}`);
  });
  page.on("pageerror", (e) => console.log("   [pageerror]", e.message));

  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
  await page.waitForFunction("window.ready === true || window.bootError", { timeout: 30000 });
  const bootErr = await page.evaluate(() => window.bootError || null);
  if (bootErr) throw new Error("boot failed: " + bootErr);

  await page.waitForFunction(
    () => {
      const v = window.view;
      return v && v.pages && v.pages[0] && v.pages[0].viewport && v.pages[0].rendered;
    },
    { timeout: 30000 }
  );
  report("PDF 打开并渲染第 1 页", true);
  await page.screenshot({ path: "test/shot-initial.png" });

  // ---------- 1. pen ----------
  const geo = await page.evaluate(() => {
    const v = window.view;
    const pe = v.pages[0];
    const r = pe.inner.getBoundingClientRect();
    const box = pe.draw.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height, drawW: box.width, drawH: box.height };
  });
  console.log("   page rect:", JSON.stringify(geo));

  await page.evaluate(() => document.querySelector('.pdfann-tool[data-tool="pen"]').click());
  const tool = await page.evaluate(() => window.view.tool);
  report("切换到画笔工具", tool === "pen", "tool=" + tool);

  const cx = geo.left + geo.w / 2;
  const cy = geo.top + geo.h / 2;
  await page.mouse.move(cx - 120, cy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(cx - 120 + i * 20, cy + Math.sin(i / 2) * 30);
  }
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 200));

  const ink = await page.evaluate(() => {
    const v = window.view;
    const pe = v.pages[0];
    const annots = v.store.annotsOf(v.file.path, 1);
    const c = pe.ink;
    const ctx = c.getContext("2d");
    // canvas backup context state after our draws is dpr-scaled; read raw pixels instead
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) painted++;
    return { count: annots.length, types: annots.map((a) => a.type), painted };
  });
  report("画笔产生了批注数据", ink.count > 0, JSON.stringify(ink.types));
  report("墨迹层有可见像素", ink.painted > 50, "painted px=" + ink.painted);

  // ---------- 2. select ----------
  const target = await page.evaluate(() => {
    const v = window.view;
    const pe = v.pages[0];
    return v.getItems(pe).then((items) => {
      const it = items.find((i) => i.str.includes("line 2:"));
      if (!it) return { found: false, sample: items.slice(0, 5).map((i) => i.str) };
      const r = pe.inner.getBoundingClientRect();
      const a = pe.viewport.convertToViewportPoint(it.bbox.x, it.bbox.y + it.bbox.h);
      const b = pe.viewport.convertToViewportPoint(it.bbox.x + it.bbox.w, it.bbox.y);
      const ax = Array.isArray(a) ? a[0] : a.x, ay = Array.isArray(a) ? a[1] : a.y;
      const bx = Array.isArray(b) ? b[0] : b.x, by = Array.isArray(b) ? b[1] : b.y;
      return {
        found: true,
        x0: r.left + Math.min(ax, bx),
        y0: r.top + Math.min(ay, by),
        x1: r.left + Math.max(ax, bx),
        y1: r.top + Math.max(ay, by),
        str: it.str,
      };
    });
  });
  console.log("   target text:", JSON.stringify(target));

  await page.evaluate(() => document.querySelector('.pdfann-tool[data-tool="select"]').click());
  await page.mouse.move(target.x0 + 2, target.y0 + 2);
  await page.mouse.down();
  await page.mouse.move((target.x0 + target.x1) / 2, (target.y0 + target.y1) / 2, { steps: 4 });
  await page.mouse.move(target.x1 - 2, target.y1 - 2, { steps: 4 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 300));

  const popup = await page.evaluate(() => {
    const el = document.querySelector(".pdfann-popup");
    return el ? el.innerText.replace(/\n/g, "|") : null;
  });
  report("划选文字弹出菜单", !!popup, popup ? popup.slice(0, 40) : "no popup");

  // ---------- 3. shape ----------
  await page.evaluate(() => document.querySelector('.pdfann-tool[data-tool="rect"]').click());
  const sy = geo.top + 320;
  await page.mouse.move(cx - 100, sy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, sy + 80, { steps: 6 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 150));
  const shape = await page.evaluate(() => {
    const v = window.view;
    const a = v.store.annotsOf(v.file.path, 1);
    return {
      count: a.length,
      types: a.map((x) => x.type),
      last: a.length ? JSON.stringify(a[a.length - 1]).slice(0, 160) : null,
      svg: v.pages[0].svg.childNodes.length,
      tool: v.tool,
    };
  });
  report("画方框产生批注", shape.types.includes("rect"), JSON.stringify(shape));

  // ---------- 3b. thin horizontal drag (no box) ----------
  await page.evaluate(() => document.querySelector(".pdfann-popup")?.remove());
  const thin = await page.evaluate(() => {
    const v = window.view, pe = v.pages[0];
    return v.getItems(pe).then((items) => {
      const it = items.find((i) => i.str.includes("line 4:"));
      const r = pe.inner.getBoundingClientRect();
      const a = pe.viewport.convertToViewportPoint(it.bbox.x, it.bbox.y + it.bbox.h / 2);
      const b = pe.viewport.convertToViewportPoint(it.bbox.x + it.bbox.w * 0.6, it.bbox.y + it.bbox.h / 2);
      const fx = (p) => (Array.isArray(p) ? p[0] : p.x);
      const fy = (p) => (Array.isArray(p) ? p[1] : p.y);
      return { x0: r.left + fx(a), y: r.top + fy(a), x1: r.left + fx(b), str: it.str.slice(0, 20) };
    });
  });
  await page.mouse.move(thin.x0, thin.y);
  await page.mouse.down();
  await page.mouse.move((thin.x0 + thin.x1) / 2, thin.y + 1, { steps: 4 });
  await page.mouse.move(thin.x1, thin.y + 2, { steps: 4 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
  const thinPopup = await page.evaluate(() => {
    const el = document.querySelector(".pdfann-popup");
    return el ? el.innerText.replace(/\n/g, "|") : null;
  });
  report("横着拖一条细线也能选中字", !!thinPopup, thinPopup ? thinPopup.slice(0, 30) : "no popup");
  await page.evaluate(() => document.querySelector(".pdfann-popup")?.remove());

  // ---------- 3b2. zero width char must not eat a cell ----------
  const zw = await page.evaluate(() => {
    const L = window.__buildLayout([
      { str: "\u200b面临着从", bbox: { x: 100, y: 500, w: 50, h: 12 }, family: "serif", size: 12 },
    ]);
    return { cells: L.cells.map((c) => ({ ch: c.ch.charCodeAt(0), x: +c.rect.x.toFixed(2), w: +c.rect.w.toFixed(2) })) };
  });
  report(
    "零宽字符不占位（不会把后一个字挤走一格）",
    zw.cells[0].w < 0.01 && Math.abs(zw.cells[1].x - 100) < 0.01,
    JSON.stringify(zw.cells.slice(0, 3))
  );

  // ---------- 3b3. a normal space still occupies its share ----------
  const sp = await page.evaluate(() => {
    const L = window.__buildLayout([
      { str: "中文 mixed text", bbox: { x: 0, y: 0, w: 100, h: 12 }, family: "serif", size: 12 },
    ]);
    const spaceCell = L.cells.find((c) => c.ch === " ");
    return { spaceW: spaceCell ? +spaceCell.rect.w.toFixed(2) : null, total: +L.cells.reduce((a, c) => a + c.rect.w, 0).toFixed(2) };
  });
  report("空格按比例占位且总宽严格等于原文宽度", sp.spaceW > 0 && Math.abs(sp.total - 100) < 0.5, JSON.stringify(sp));

  // ---------- 3c. partial line selection (start / end inside a line) ----------
  const part = await page.evaluate(() => {
    const v = window.view, pe = v.pages[0];
    const r = pe.inner.getBoundingClientRect();
    const fx = (p) => (Array.isArray(p) ? p[0] : p.x);
    const fy = (p) => (Array.isArray(p) ? p[1] : p.y);
    return v.getItems(pe).then((items) => {
      const it = items.find((i) => i.str.includes("quick brown"));
      const b = it.bbox;
      const at = (k) => {
        const p = pe.viewport.convertToViewportPoint(b.x + b.w * k, b.y + b.h / 2);
        return { x: r.left + fx(p), y: r.top + fy(p) };
      };
      return { str: it.str, a: at(0.28), b: at(0.62), w: b.w };
    });
  });
  await page.mouse.move(part.a.x, part.a.y);
  await page.mouse.down();
  await page.mouse.move((part.a.x + part.b.x) / 2, part.a.y, { steps: 4 });
  await page.mouse.move(part.b.x, part.b.y, { steps: 4 });
  const liveSel = await page.evaluate(() => document.querySelectorAll(".pdfann-selrect").length);
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
  const partOut = await page.evaluate(() => {
    const el = document.querySelector(".pdfann-popup");
    return {
      snippet: el ? el.querySelector(".pdfann-popup-text")?.textContent : null,
      rects: document.querySelectorAll(".pdfann-selrect").length,
      width: document.querySelector(".pdfann-selrect")?.getBoundingClientRect().width || 0,
    };
  });
  const wantPart = part.str.slice(Math.round(part.str.length * 0.28), Math.round(part.str.length * 0.62));
  report(
    "拖选一行中间的一段（不满一行）",
    !!partOut.snippet &&
      partOut.snippet.length > 3 &&
      partOut.snippet.length < part.str.length - 4 &&
      partOut.rects === 1,
    JSON.stringify({ want: wantPart, got: partOut.snippet, rects: partOut.rects, w: Math.round(partOut.width) })
  );
  report("拖选过程有可见选区底色", liveSel > 0, "selrect=" + liveSel);
  report("松手后选区仍然高亮着（点按钮前可见）", partOut.rects > 0, "selrect=" + partOut.rects);
  await page.evaluate(() => document.querySelector(".pdfann-popup")?.remove());

  // ---------- 3d. selection across two lines ----------
  const two = await page.evaluate(() => {
    const v = window.view, pe = v.pages[0];
    const r = pe.inner.getBoundingClientRect();
    const fx = (p) => (Array.isArray(p) ? p[0] : p.x);
    const fy = (p) => (Array.isArray(p) ? p[1] : p.y);
    return v.getItems(pe).then((items) => {
      const a = items.find((i) => i.str.startsWith("Page 1 line 1:"));
      const b = items.find((i) => i.str.startsWith("Page 1 line 2:"));
      const at = (it, k) => {
        const p = pe.viewport.convertToViewportPoint(it.bbox.x + it.bbox.w * k, it.bbox.y + it.bbox.h / 2);
        return { x: r.left + fx(p), y: r.top + fy(p) };
      };
      return { a: at(a, 0.55), b: at(b, 0.35), s1: a.str, s2: b.str };
    });
  });
  await page.mouse.move(two.a.x, two.a.y);
  await page.mouse.down();
  await page.mouse.move(two.b.x, two.b.y, { steps: 10 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
  const twoOut = await page.evaluate(() => ({
    rects: document.querySelectorAll(".pdfann-selrect").length,
    snippet: document.querySelector(".pdfann-popup-text")?.textContent || null,
  }));
  report(
    "跨行选一段（两行各取后半/前半）",
    twoOut.rects === 2 && !!twoOut.snippet && twoOut.snippet.includes("…"),
    JSON.stringify(twoOut)
  );
  await page.evaluate(() => document.querySelector(".pdfann-popup")?.remove());

  // ---------- 3e. double click picks one word ----------
  const w = await page.evaluate(() => {
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
  await page.mouse.click(w.x, w.y);
  await page.mouse.click(w.x, w.y, { clickCount: 2 });
  await new Promise((r) => setTimeout(r, 250));
  const wordOut = await page.evaluate(() => ({
    snippet: document.querySelector(".pdfann-popup-text")?.textContent || null,
    rects: document.querySelectorAll(".pdfann-selrect").length,
  }));
  report("双击选中一个单词", wordOut.snippet === "brown" && wordOut.rects === 1, JSON.stringify(wordOut));
  await page.screenshot({ path: "test/shot-selection.png" });
  await page.evaluate(() => document.querySelector(".pdfann-popup")?.remove());

  // ---------- 4. apply highlight from popup ----------
  await page.evaluate(() => document.querySelector('.pdfann-tool[data-tool="select"]').click());
  await page.mouse.move(target.x0 + 2, target.y0 + 2);
  await page.mouse.down();
  await page.mouse.move((target.x0 + target.x1) / 2, (target.y0 + target.y1) / 2, { steps: 4 });
  await page.mouse.move(target.x1 - 2, target.y1 - 2, { steps: 4 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll(".pdfann-popup button"));
    const b = btns.find((x) => x.textContent.trim() === "高亮");
    b && b.click();
  });
  await new Promise((r) => setTimeout(r, 250));
  const hi = await page.evaluate(() => {
    const v = window.view;
    const a = v.store.annotsOf(v.file.path, 1);
    const mark = a.find((x) => x.type === "highlight");
    return {
      types: a.map((x) => x.type),
      rects: mark ? mark.rects.length : 0,
      text: mark ? mark.text.slice(0, 30) : null,
      svg: v.pages[0].svg.childNodes.length,
      popup: !!document.querySelector(".pdfann-popup"),
    };
  });
  report("高亮写入批注并绘制", hi.types.includes("highlight") && hi.rects > 0 && hi.svg > 0, JSON.stringify(hi));

  // ---------- 5. zoom keeps annotations aligned ----------
  const beforeZoom = await page.evaluate(() => {
    const v = window.view;
    v.setScale(v.scale * 1.4);
    return true;
  });
  await new Promise((r) => setTimeout(r, 800));
  const zoom = await page.evaluate(() => {
    const v = window.view, pe = v.pages[0];
    const c = pe.ink, ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) painted++;
    return { scale: v.scale, painted, svg: pe.svg.childNodes.length, rendered: pe.rendered };
  });
  report("放大后墨迹与图形仍然绘制", zoom.painted > 0 && zoom.svg > 0, JSON.stringify(zoom));

  // ---------- 6. dump annots for the burn round trip ----------
  const dump = await page.evaluate(() => JSON.stringify(window.view.store.annotsOf(window.view.file.path)));
  fs.writeFileSync(path.resolve("test/live-annots.json"), dump);

  // ---------- 7. undo ----------
  const undo = await page.evaluate(async () => {
    const v = window.view;
    const before = v.store.annotsOf(v.file.path).length;
    v.undo();
    const after = v.store.annotsOf(v.file.path).length;
    v.redo();
    const redo = v.store.annotsOf(v.file.path).length;
    return { before, after, redo };
  });
  report("撤销/重做", undo.after === undo.before - 1 && undo.redo === undo.before, JSON.stringify(undo));

  // ---------- 8. eraser ----------
  const erased = await page.evaluate(() => window.view.store.annotsOf(window.view.file.path).map((a) => a.type));
  console.log("   annots before erase:", JSON.stringify(erased));

  // ---------- 9. drag a shape ----------
  const shapeDrag = await page.evaluate(() => {
    const v = window.view, pe = v.pages[0];
    const a = v.store.annotsOf(v.file.path, 1).find((x) => x.type === "rect");
    if (!a) return { ok: false };
    const r = pe.inner.getBoundingClientRect();
    const c = pe.viewport.convertToPdfPoint(
      (a.p0.x + a.p1.x) / 2,
      (a.p0.y + a.p1.y) / 2
    );
    const cp = pe.viewport.convertToViewportPoint((a.p0.x + a.p1.x) / 2, (a.p0.y + a.p1.y) / 2);
    const fx = (p) => (Array.isArray(p) ? p[0] : p.x);
    const fy = (p) => (Array.isArray(p) ? p[1] : p.y);
    return { ok: true, x: r.left + fx(cp), y: r.top + fy(cp), p0: { ...a.p0 } };
  });
  if (shapeDrag.ok) {
    await page.evaluate(() => document.querySelector('.pdfann-tool[data-tool="select"]').click());
    await page.evaluate(() => {
      const v = window.view;
      const a = v.store.annotsOf(v.file.path, 1).find((x) => x.type === "rect");
      v.selectedId = a.id;
      v.updateOptions();
    });
    await page.mouse.move(shapeDrag.x, shapeDrag.y);
    await page.mouse.down();
    await page.mouse.move(shapeDrag.x + 60, shapeDrag.y + 40, { steps: 8 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 200));
  }
  const moved = await page.evaluate(() => {
    const v = window.view;
    const a = v.store.annotsOf(v.file.path, 1).find((x) => x.type === "rect");
    return a ? { p0: a.p0 } : null;
  });
  report(
    "图形可以拖动",
    !!(moved && shapeDrag.ok && Math.abs(moved.p0.x - shapeDrag.p0.x) > 5),
    JSON.stringify({ before: shapeDrag.p0, after: moved && moved.p0 })
  );

  // ---------- 10. page jump ----------
  await page.evaluate(() => {
    const v = window.view;
    const inp = v.pageInput;
    inp.value = "3";
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 600));
  const jumped = await page.evaluate(() => ({ page: window.view.currentPage, scroll: Math.round(window.view.scrollEl.scrollTop) }));
  report("页码输入跳转", jumped.page === 3 && jumped.scroll > 0, JSON.stringify(jumped));

  // ---------- 11. eraser removes ink ----------
  await page.evaluate(() => window.view.goPage(1));
  await new Promise((r) => setTimeout(r, 500));
  const inkPos = await page.evaluate(() => {
    const v = window.view, pe = v.pages[0];
    const ink = v.store.annotsOf(v.file.path, 1).find((a) => a.type === "ink");
    if (!ink) return null;
    const fx = (p) => (Array.isArray(p) ? p[0] : p.x);
    const fy = (p) => (Array.isArray(p) ? p[1] : p.y);
    const mid = pe.viewport.convertToViewportPoint(ink.strokes[0][0].x, ink.strokes[0][0].y);
    v.scrollEl.scrollTop += fy(mid) - 300;
    const r = pe.inner.getBoundingClientRect();
    for (const q of ink.strokes[0]) {
      const cp = pe.viewport.convertToViewportPoint(q.x, q.y);
      const y = r.top + fy(cp);
      const x = r.left + fx(cp);
      if (y > 80 && y < 820 && x > 60 && x < 1100) return { x, y };
    }
    return null;
  });
  console.log("   inkPos:", JSON.stringify(inkPos));
  if (inkPos) {
    await page.evaluate(() => document.querySelector('.pdfann-tool[data-tool="eraser"]').click());
    await page.mouse.move(inkPos.x, inkPos.y);
    await page.mouse.down();
    await page.mouse.move(inkPos.x + 4, inkPos.y + 2);
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 250));
  }
  const erasedTypes = await page.evaluate(() => window.view.store.annotsOf(window.view.file.path, 1).map((a) => a.type));
  console.log("   tool after erase:", await page.evaluate(() => window.view.tool));
  report("橡皮擦掉笔迹", !!inkPos && !erasedTypes.includes("ink"), JSON.stringify(erasedTypes));

  // ---------- 3.5 note & text box render as readable text ----------
  const cards = await page.evaluate(async () => {
    const v = window.view;
    const now = Date.now();
    window.store.add(v.file.path, {
      id: "t-note",
      page: 1,
      type: "note",
      color: "#f2c200",
      pt: { x: 300, y: 240 },
      text: "便签正文要能看见",
      created: now,
      updated: now,
    });
    window.store.add(v.file.path, {
      id: "t-box",
      page: 1,
      type: "textbox",
      color: "#1f2430",
      size: 12,
      pt: { x: 80, y: 180 },
      w: 200,
      text: "文本框第一行\nsecond line",
      bg: null,
      created: now,
      updated: now,
    });
    v.paintPage(v.pages[0]);
    const texts = Array.from(document.querySelectorAll(".pdfann-textcard text")).map((t) => t.textContent);
    return texts;
  });
  report(
    "便签与文字批注以真实文字显示",
    cards.join("|").includes("便签正文要能看见") && cards.join("|").includes("second line"),
    JSON.stringify(cards)
  );

  const burnInfo = await page.evaluate(async () => {
    const v = window.view;
    const annots = v.store.annotsOf(v.file.path, 1).filter((a) => a.type === "note" || a.type === "textbox");
    const out = await window.__burn(v.pdfBytes, annots);
    const txt = new TextDecoder("latin1").decode(out);
    return { images: (txt.match(/\/Subtype\s*\/Image/g) || []).length, bytes: out.length };
  });
  report("烧入时便签/文字写成图文而非图标", burnInfo.images >= 2, JSON.stringify(burnInfo));

  // ---------- 4. eraser / persist sanity ----------
  const sum = await page.evaluate(() => {
    const v = window.view;
    return { tool: v.tool, annots: v.store.annotsOf(v.file.path).length, scale: v.scale };
  });
  console.log("   state:", JSON.stringify(sum));

  await page.screenshot({ path: "test/shot-final.png" });
  await page.evaluate(() => window.view.flushSave());
  await browser.close();
  server.close();
  console.log("\n" + log.join("\n"));
  console.log("\n" + log.filter((l) => l.startsWith("FAIL")).length + " failure(s)");
  process.exit(log.some((l) => l.startsWith("FAIL")) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
