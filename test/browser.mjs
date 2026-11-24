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

  // ---------- 3.6 the width slider means "font size" for text and notes ----------
  const setSlider = async (val) => {
    await page.evaluate((v) => {
      const r = document.querySelector(".pdfann-range");
      r.value = String(v);
      r.dispatchEvent(new Event("input", { bubbles: true }));
    }, val);
    await new Promise((r) => setTimeout(r, 120));
  };
  const toolBtn = async (id) => {
    await page.evaluate((t) => document.querySelector(`.pdfann-tool[data-tool="${t}"]`).click(), id);
    await new Promise((r) => setTimeout(r, 120));
  };

  await toolBtn("textbox");
  const before = await page.evaluate(() => ({
    shape: window.view.settings.shapeWidth,
    size: window.view.settings.textSize,
    label: document.querySelector(".pdfann-width-label").textContent,
    max: document.querySelector(".pdfann-range").max,
  }));
  await setSlider(30);
  const afterSlide = await page.evaluate(() => ({
    shape: window.view.settings.shapeWidth,
    size: window.view.settings.textSize,
    shown: document.querySelector(".pdfann-width-val").textContent,
  }));
  report(
    "文字工具下拖滑块改的是字号，不是线宽",
    afterSlide.size === 30 && afterSlide.shape <= 5 && before.label === "字号",
    JSON.stringify({ before, afterSlide })
  );

  // A selected text box follows the slider too, and the glyphs really grow.
  const boxSize = await page.evaluate(async () => {
    const v = window.view;
    const id = "size-box";
    window.store.remove(v.file.path, id);
    window.store.add(v.file.path, {
      id,
      page: 1,
      type: "textbox",
      color: "#1f2430",
      size: 12,
      pt: { x: 90, y: 300 },
      w: 200,
      text: "字号测试 ABC",
      bg: null,
      created: Date.now(),
      updated: Date.now(),
    });
    v.paintPage(v.pages[0]);
    v.selectedId = id;
    v.updateOptions();
    const cardOf = (needle) =>
      Array.from(document.querySelectorAll(".pdfann-textcard")).find((g) => (g.textContent || "").includes(needle));
    const fs0 = Number(cardOf("字号测试").querySelector("text").getAttribute("font-size"));
    const r = document.querySelector(".pdfann-range");
    r.value = "22";
    r.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((x) => setTimeout(x, 150));
    const a = v.store.find(v.file.path, id);
    const fs1 = Number(cardOf("字号测试").querySelector("text").getAttribute("font-size"));
    return { fs0, fs1, size: a && a.size, shape: v.settings.shapeWidth };
  });
  report(
    "选中的文字批注能改字号（字形真的变大）",
    boxSize.size === 22 && boxSize.fs1 > boxSize.fs0 * 1.5 && boxSize.shape <= 5,
    JSON.stringify(boxSize)
  );

  // Notes had the same defect: the slider never reached the note.
  await toolBtn("note");
  const noteLabel = await page.evaluate(() => document.querySelector(".pdfann-width-label").textContent);
  await setSlider(16);
  const noteSizes = await page.evaluate(async () => {
    const v = window.view;
    v.selectedId = "t-note";
    v.updateOptions();
    const r = document.querySelector(".pdfann-range");
    r.value = "13";
    r.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((x) => setTimeout(x, 150));
    const a = v.store.find(v.file.path, "t-note");
    const noteCard = Array.from(document.querySelectorAll(".pdfann-textcard")).find((g) =>
      (g.textContent || "").includes("便签正文要能看见")
    );
    const card = noteCard ? Array.from(noteCard.querySelectorAll("text")).map((t) => t.getAttribute("font-size")) : [];
    return { setting: v.settings.noteSize, annot: a && a.size, card, scale: v.scale };
  });
  const notePx = Number(noteSizes.card[0] || 0);
  report(
    "便签同样能改字号（字号只改这一条，不动默认值）",
    noteLabel === "字号" &&
      noteSizes.setting === 16 &&
      noteSizes.annot === 13 &&
      Math.abs(notePx - 13 * noteSizes.scale) < 1,
    JSON.stringify({ noteLabel, noteSizes })
  );

  // The pen must keep writing the stroke width, not the font size.
  await toolBtn("pen");
  await setSlider(4);
  const penPen = await page.evaluate(() => ({
    pen: window.view.settings.penWidth,
    text: window.view.settings.textSize,
  }));
  report("画笔滑块仍然只改线宽", penPen.pen === 4 && penPen.text === 30, JSON.stringify(penPen));
  await page.evaluate(() => {
    window.view.selectedId = null;
    window.view.updateOptions();
  });

  // ---------- 3.7 slider ranges + arrow head geometry ----------
  const limits = await page.evaluate(() => {
    const v = window.view;
    const read = (tool) => {
      v.setTool(tool);
      const r = document.querySelector(".pdfann-range");
      return `${r.min}/${r.max}/${r.step}`;
    };
    v.selectedId = null;
    const out = {
      rect: read("rect"),
      line: read("line"),
      ellipse: read("ellipse"),
      arrow: read("arrow"),
      textbox: read("textbox"),
      note: read("note"),
      pen: read("pen"),
    };
    v.setTool("select");
    return out;
  });
  report(
    "量程：图形粗细 0.5–13，字号 6–30，画笔仍到 30",
    limits.rect === "0.5/13/0.5" &&
      limits.line === "0.5/13/0.5" &&
      limits.ellipse === "0.5/13/0.5" &&
      limits.arrow === "0.5/13/0.5" &&
      limits.textbox === "6/30/1" &&
      limits.note === "6/30/1" &&
      limits.pen === "0.5/30/0.5",
    JSON.stringify(limits)
  );

  // A thick arrow must not let its shaft poke through the point: the shaft ends
  // at the base of the filled head, and the head grows with the stroke width.
  const arrowGeom = await page.evaluate(() => {
    const v = window.view;
    v.setTool("select");
    v.selectedId = null;
    const make = (id, width, x0) => {
      v.store.remove(v.file.path, id);
      v.store.add(v.file.path, {
        id,
        page: 1,
        type: "arrow",
        color: "#f08c1a",
        width,
        p0: { x: x0, y: 520 },
        p1: { x: x0 + 200, y: 520 },
        created: Date.now(),
        updated: Date.now(),
      });
    };
    const measure = (id) => {
      v.paintPage(v.pages[0]);
      const g = Array.from(v.pages[0].svg.querySelectorAll("g")).find(
        (x) => x.querySelector('line[stroke="#f08c1a"]') && x.querySelector('polygon[fill="#f08c1a"]')
      );
      const line = g.querySelector("line");
      const poly = g.querySelector("polygon");
      const pts = poly.getAttribute("points").trim().split(" ").map((p) => p.split(",").map(Number));
      const tip = pts[0];
      const base = pts[1];
      return {
        head: Math.abs(tip[0] - base[0]),
        gap: Math.abs(tip[0] - Number(line.getAttribute("x2"))),
        cap: line.getAttribute("stroke-linecap"),
        strokeW: Number(line.getAttribute("stroke-width")),
        tipY: tip[1],
        shaftY: Number(line.getAttribute("y2")),
      };
    };
    make("arrow-fat", 13, 120);
    const fat = measure("arrow-fat");
    const wings = (() => {
      const poly = v.pages[0].svg.querySelector('polygon[fill="#f08c1a"]');
      const pts = poly.getAttribute("points").trim().split(" ").map((p) => p.split(",").map(Number));
      return Math.abs(pts[1][1] - pts[2][1]);
    })();
    v.store.remove(v.file.path, "arrow-fat");
    v.paintPage(v.pages[0]);
    make("arrow-thin", 6.5, 120);
    const thin = measure("arrow-thin");
    const scale = v.scale;
    for (const id of ["arrow-fat", "arrow-thin"]) v.store.remove(v.file.path, id);
    v.paintPage(v.pages[0]);
    return { fat, thin, wings, scale };
  });
  report(
    "粗箭头：箭柄停在箭头底部，圆头不再顶出箭尖",
    arrowGeom.fat.cap === "butt" &&
      arrowGeom.fat.gap > arrowGeom.fat.head * 0.7 &&
      Math.abs(arrowGeom.fat.shaftY - arrowGeom.fat.tipY) < 0.01 &&
      arrowGeom.wings > arrowGeom.fat.head * 0.6,
    JSON.stringify(arrowGeom)
  );
  report(
    "箭头大小只随线宽变（6.5 与 13 差一倍）",
    Math.abs(arrowGeom.fat.head / arrowGeom.thin.head - 2) < 0.05,
    JSON.stringify({ fat: arrowGeom.fat.head, thin: arrowGeom.thin.head })
  );

  // The burned PDF must carry the same filled triangle (probe14 checks the
  // pixels; here we only make sure the head is really written into the page).
  const burnArrow = await page.evaluate(async () => {
    const v = window.view;
    const base = { id: "b1", page: 1, color: "#f08c1a", width: 13, p0: { x: 120, y: 520 }, p1: { x: 320, y: 520 } };
    const asArrow = await window.__burn(v.pdfBytes, [{ ...base, type: "arrow", created: 1, updated: 1 }]);
    const asLine = await window.__burn(v.pdfBytes, [{ ...base, type: "line", created: 1, updated: 1 }]);
    const txt = new TextDecoder("latin1").decode(asArrow);
    return { arrow: asArrow.length, line: asLine.length, same: asArrow.length === asLine.length, img: (txt.match(/\/Subtype\s*\/Image/g) || []).length };
  });
  report(
    "烧入的箭头额外写入三角头（比直线多出一段绘制指令）",
    !burnArrow.same && burnArrow.arrow > burnArrow.line,
    JSON.stringify(burnArrow)
  );

  // ---------- 3.8 underline / strike rule thickness ----------
  const rules = await page.evaluate(() => {
    const v = window.view;
    v.setTool("select");
    v.selectedId = null;
    const rect = { x: 80, y: 300, w: 200, h: 13 };
    const put = (id, type) => {
      v.store.remove(v.file.path, id);
      v.store.add(v.file.path, {
        id,
        page: 1,
        type,
        color: "#e8537a",
        rects: [rect],
        text: "rule probe",
        created: 1,
        updated: 1,
      });
    };
    const read = (id) => {
      v.paintPage(v.pages[0]);
      const line = Array.from(v.pages[0].svg.querySelectorAll('line[stroke="#e8537a"]')).pop();
      const sr = v.screenRect(v.pages[0], rect);
      return {
        w: Number(line.getAttribute("stroke-width")),
        y: Number(line.getAttribute("y1")),
        cap: line.getAttribute("stroke-linecap"),
        bottom: sr.y + sr.h,
        middle: sr.y + sr.h / 2,
        scale: v.scale,
      };
    };
    put("rule-u", "underline");
    const u = read("rule-u");
    put("rule-s", "strike");
    const s = read("rule-s");
    for (const id of ["rule-u", "rule-s"]) v.store.remove(v.file.path, id);
    v.paintPage(v.pages[0]);
    return { u, s };
  });
  report(
    "下划线/删除线加粗到 2.5 pt，且贴在文字框底边（删除线居中）",
    Math.abs(rules.u.w - 2.5 * rules.u.scale) < 0.05 &&
      Math.abs(rules.s.w - 2.5 * rules.s.scale) < 0.05 &&
      Math.abs(rules.u.y - rules.u.bottom) < 0.5 &&
      Math.abs(rules.s.y - rules.s.middle) < 0.5 &&
      rules.u.cap === "butt",
    JSON.stringify(rules)
  );

  // An old annotation wider than today's limit still renders, it is just
  // clamped the next time the user touches the slider.
  const legacy = await page.evaluate(() => {
    const v = window.view;
    const id = "arrow-legacy";
    v.store.remove(v.file.path, id);
    v.store.add(v.file.path, {
      id,
      page: 1,
      type: "arrow",
      color: "#f08c1a",
      width: 26,
      p0: { x: 120, y: 480 },
      p1: { x: 320, y: 480 },
      created: Date.now(),
      updated: Date.now(),
    });
    v.paintPage(v.pages[0]);
    v.selectedId = id;
    v.updateOptions();
    const r = document.querySelector(".pdfann-range");
    const shown = document.querySelector(".pdfann-width-val").textContent;
    const kept = v.store.find(v.file.path, id).width;
    r.value = "13";
    r.dispatchEvent(new Event("input", { bubbles: true }));
    const after = v.store.find(v.file.path, id).width;
    v.store.remove(v.file.path, id);
    v.selectedId = null;
    v.paintPage(v.pages[0]);
    return { shown, clamped: r.max, kept, after };
  });
  report(
    "旧数据超限不报错：滑块顶到 13 才改",
    legacy.clamped === "13" && legacy.kept === 26 && legacy.after === 13,
    JSON.stringify(legacy)
  );

  // ---------- 13. grab and drag while a creating tool is still armed ----------
  await page.evaluate(() => {
    const v = window.view;
    v.goPage(1);
    v.scrollEl.scrollTop = 0;
  });
  await new Promise((r) => setTimeout(r, 500));

  const mid = await page.evaluate(() => {
    const v = window.view, pe = v.pages[0];
    const r = pe.inner.getBoundingClientRect();
    const fx = (q) => (Array.isArray(q) ? q[0] : q.x);
    const fy = (q) => (Array.isArray(q) ? q[1] : q.y);
    window.__toScreen = (x, y) => {
      const rr = pe.inner.getBoundingClientRect();
      const p = pe.viewport.convertToViewportPoint(x, y);
      return { x: rr.left + fx(p), y: rr.top + fy(p) };
    };
    const c = pe.viewport.convertToPdfPoint(r.width / 2, r.height / 2);
    return { x: fx(c), y: fy(c), scale: v.scale };
  });

  const pointFor = async (pdfPt) => {
    // Scroll the target into the visible strip first — at 2x zoom a page is
    // 1700 px tall, and a pointer event outside the scroller simply does nothing.
    await page.evaluate((q) => {
      const v = window.view, pe = v.pages[0];
      const r = pe.inner.getBoundingClientRect();
      const p = pe.viewport.convertToViewportPoint(q.x, q.y);
      const fy = (a) => (Array.isArray(a) ? a[1] : a.y);
      const box = v.scrollEl.getBoundingClientRect();
      const want = r.top + fy(p);
      if (want < box.top + 60 || want > box.top + box.height - 60) {
        v.scrollEl.scrollTop += want - (box.top + box.height * 0.45);
      }
    }, pdfPt);
    await new Promise((r) => setTimeout(r, 350));
    return page.evaluate((q) => window.__toScreen(q.x, q.y), pdfPt);
  };

  const dragBy = async (pressPdf, toolId, dxPx, dyPx) => {
    await page.evaluate((id) => document.querySelector(`.pdfann-tool[data-tool="${id}"]`).click(), toolId);
    const p = await pointFor(pressPdf);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + dxPx, p.y + dyPx, { steps: 10 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 200));
  };

  // text box: press inside the card, 70x50 px, with the text box tool armed
  const tbDrag = await page.evaluate((c) => {
    const v = window.view;
    const now = Date.now();
    v.store.add(v.file.path, {
      id: "drag-tb", page: 1, type: "textbox", color: "#1f2430", size: 11,
      pt: { x: c.x - 70, y: c.y + 30 }, w: 160, text: "拖动这个文字块",
      bg: null, created: now, updated: now,
    });
    v.paintPage(v.pages[0]);
    const a = v.store.annotsOf(v.file.path, 1).find((x) => x.id === "drag-tb");
    return { pt: { ...a.pt }, n: v.store.annotsOf(v.file.path, 1).filter((x) => x.type === "textbox").length };
  }, mid);
  await dragBy({ x: tbDrag.pt.x + 25, y: tbDrag.pt.y - 12 }, "textbox", 70, 50);
  const tbAfter = await page.evaluate(() => {
    const v = window.view;
    const list = v.store.annotsOf(v.file.path, 1);
    return { pt: list.find((x) => x.id === "drag-tb").pt, n: list.filter((x) => x.type === "textbox").length };
  });
  report(
    "文字批注：工具仍选中时可直接拖动已有文字块",
    Math.abs(tbAfter.pt.x - tbDrag.pt.x) > 5 && Math.abs(tbAfter.pt.y - tbDrag.pt.y) > 5 && tbAfter.n === tbDrag.n,
    JSON.stringify({ before: tbDrag.pt, after: tbAfter.pt, count: tbDrag.n + "->" + tbAfter.n })
  );

  // note: press the pin, with the note tool armed
  const noteDrag = await page.evaluate((c) => {
    const v = window.view;
    const now = Date.now();
    v.store.add(v.file.path, {
      id: "drag-note", page: 1, type: "note", color: "#f2c200",
      pt: { x: c.x + 60, y: c.y - 40 }, text: "拖动这个便签",
      created: now, updated: now,
    });
    v.paintPage(v.pages[0]);
    const a = v.store.annotsOf(v.file.path, 1).find((x) => x.id === "drag-note");
    return { pt: { ...a.pt }, n: v.store.annotsOf(v.file.path, 1).filter((x) => x.type === "note").length };
  }, mid);
  await dragBy({ x: noteDrag.pt.x - 1, y: noteDrag.pt.y - 8 }, "note", -60, 40);
  const noteAfter = await page.evaluate(() => {
    const v = window.view;
    const list = v.store.annotsOf(v.file.path, 1);
    return { pt: list.find((x) => x.id === "drag-note").pt, n: list.filter((x) => x.type === "note").length };
  });
  report(
    "便签：工具仍选中时可直接拖动已有便签",
    Math.abs(noteAfter.pt.x - noteDrag.pt.x) > 5 && noteAfter.n === noteDrag.n,
    JSON.stringify({ before: noteDrag.pt, after: noteAfter.pt, count: noteDrag.n + "->" + noteAfter.n })
  );

  // rect: press its border (the interior stays free for drawing a nested box)
  const rectDrag = await page.evaluate((c) => {
    const v = window.view;
    const now = Date.now();
    v.store.add(v.file.path, {
      id: "drag-rect", page: 1, type: "rect", color: "#f08c1a", width: 1.6,
      p0: { x: c.x - 90, y: c.y + 90 }, p1: { x: c.x + 90, y: c.y - 20 },
      created: now, updated: now,
    });
    v.paintPage(v.pages[0]);
    const a = v.store.annotsOf(v.file.path, 1).find((x) => x.id === "drag-rect");
    return { p0: { ...a.p0 }, n: v.store.annotsOf(v.file.path, 1).filter((x) => x.type === "rect").length };
  }, mid);
  await dragBy({ x: mid.x - 90, y: mid.y + 35 }, "rect", 40, 30);
  const rectAfter = await page.evaluate(() => {
    const v = window.view;
    const list = v.store.annotsOf(v.file.path, 1);
    return { p0: list.find((x) => x.id === "drag-rect").p0, n: list.filter((x) => x.type === "rect").length };
  });
  report(
    "图形：工具仍选中时可直接拖动已有方框（拖边框，框内仍可继续画新框）",
    Math.abs(rectAfter.p0.x - rectDrag.p0.x) > 5 && rectAfter.n === rectDrag.n,
    JSON.stringify({ before: rectDrag.p0, after: rectAfter.p0, count: rectDrag.n + "->" + rectAfter.n })
  );

  // ink with the pen armed — the toggle decides between "keep drawing" (default)
  // and "drag the stroke you pressed on".
  const seedInk = async (id, dy) =>
    page.evaluate(
      (c, name, off) => {
        const v = window.view;
        const now = Date.now();
        window.store.remove(v.file.path, name);
        const strokes = [[{ x: c.x - 80, y: c.y + off }, { x: c.x - 20, y: c.y + off }, { x: c.x + 60, y: c.y + off }]];
        v.store.add(v.file.path, {
          id: name, page: 1, type: "ink", color: "#e03131", width: 4, opacity: 1,
          strokes, created: now, updated: now,
        });
        v.paintPage(v.pages[0]);
        return {
          first: { ...strokes[0][0] },
          n: v.store.annotsOf(v.file.path, 1).filter((x) => x.type === "ink").length,
        };
      },
      mid,
      id,
      dy
    );
  const readInk = async (id) =>
    page.evaluate((name) => {
      const v = window.view;
      const list = v.store.annotsOf(v.file.path, 1);
      const a = list.find((x) => x.id === name);
      return { first: a ? { ...a.strokes[0][0] } : null, n: list.filter((x) => x.type === "ink").length };
    }, id);

  // default = off: the press starts a new stroke, the old one stays put
  const inkOff = await seedInk("drag-ink", -120);
  await dragBy({ x: inkOff.first.x + 40, y: inkOff.first.y }, "pen", 50, 45);
  const inkOffAfter = await readInk("drag-ink");
  report(
    "画笔默认（开关关闭）：按在已有笔迹上继续起笔，不拖走原来的",
    inkOffAfter.first &&
      Math.abs(inkOffAfter.first.x - inkOff.first.x) < 1 &&
      inkOffAfter.n === inkOff.n + 1,
    JSON.stringify({ before: inkOff.first, after: inkOffAfter.first, count: inkOff.n + "->" + inkOffAfter.n })
  );

  // switch it on: the same gesture now moves the stroke and adds nothing
  const inkOn = await seedInk("drag-ink2", -170);
  await page.evaluate(() => {
    window.view.settings.penDragInk = true;
  });
  await dragBy({ x: inkOn.first.x + 40, y: inkOn.first.y }, "pen", 50, 45);
  const inkOnAfter = await readInk("drag-ink2");
  report(
    "打开开关后：按在已有笔迹上直接拖走，不多画一笔",
    inkOnAfter.first &&
      Math.abs(inkOnAfter.first.x - inkOn.first.x) > 5 &&
      inkOnAfter.n === inkOn.n,
    JSON.stringify({ before: inkOn.first, after: inkOnAfter.first, count: inkOn.n + "->" + inkOnAfter.n })
  );

  // ink in select mode
  await page.evaluate(() => document.querySelector('.pdfann-tool[data-tool="select"]').click());
  const selInkBefore = await page.evaluate(() => {
    const v = window.view;
    const a = v.store.annotsOf(v.file.path, 1).find((x) => x.id === "drag-ink2");
    return { ...a.strokes[0][0] };
  });
  const selPress = await pointFor(selInkBefore);
  await page.mouse.move(selPress.x + 40, selPress.y);
  await page.mouse.down();
  await page.mouse.move(selPress.x + 40 - 45, selPress.y + 40, { steps: 10 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 200));
  const selInkAfter = await page.evaluate(() => {
    const v = window.view;
    const a = v.store.annotsOf(v.file.path, 1).find((x) => x.id === "drag-ink");
    return { ...a.strokes[0][0] };
  });
  report(
    "「选中」工具下笔迹也能拖动",
    Math.abs(selInkAfter.x - selInkBefore.x) > 5,
    JSON.stringify({ before: selInkBefore, after: selInkAfter })
  );

  const toolLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".pdfann-tool-label")).map((e) => e.textContent)
  );
  report("工具栏标签为「选中」", toolLabels[0] === "选中", JSON.stringify(toolLabels));

  // tidy up so the final screenshot shows the demo annotations only
  await page.evaluate(() => {
    const v = window.view;
    for (const id of ["drag-tb", "drag-note", "drag-rect", "drag-ink"]) v.store.remove(v.file.path, id);
    v.setTool("select");
    v.repaintAll();
  });

  // ---------- 4. eraser / persist sanity ----------
  const sum = await page.evaluate(() => {
    const v = window.view;
    return { tool: v.tool, annots: v.store.annotsOf(v.file.path).length, scale: v.scale };
  });
  console.log("   state:", JSON.stringify(sum));

  // ---------- 14. language switch ----------
  const en = await page.evaluate(() => {
    window.setLang("en");
    const rail = Array.from(document.querySelectorAll(".pdfann-tool-label")).map((e) => e.textContent);
    const opts = document.querySelector(".pdfann-opts-label")?.textContent || "";
    const tabs = Array.from(document.querySelectorAll(".pdfann-tab")).map((e) => e.textContent);
    const empty = document.querySelector(".pdfann-empty-state")?.textContent || "";
    return { rail, opts, tabs, empty };
  });
  report(
    "切到英文：工具栏、选项栏、侧栏标签都是英文",
    en.rail.includes("Select") && en.rail.includes("Pen") && en.rail.includes("Text") &&
      en.rail.includes("Undo") && en.tabs.includes("Notes") && en.tabs.includes("Outline") &&
      /Select/.test(en.opts),
    JSON.stringify(en)
  );

  const enSettings = await page.evaluate(() => {
    const tab = window.openSettings();
    const rows = Array.from(tab.containerEl.querySelectorAll(".setting-item"));
    return {
      names: rows.map((r) => r.querySelector(".setting-item-name")?.textContent || "").filter(Boolean),
      options: Array.from(tab.containerEl.querySelectorAll("select option")).map((o) => o.textContent),
      headings: Array.from(tab.containerEl.querySelectorAll(".setting-item-heading .setting-item-name")).map((e) => e.textContent),
    };
  });
  report(
    "英文设置页：分组、开关与语言下拉都是英文",
    enSettings.names.includes("Interface language") &&
      enSettings.names.includes("Drag ink when the pen presses on it") &&
      enSettings.options.includes("Follow system") &&
      enSettings.options.includes("中文") &&
      enSettings.headings.includes("Language"),
    JSON.stringify(enSettings)
  );

  const enMd = await page.evaluate(() => {
    const v = window.view;
    const annots = v.store.annotsOf(v.file.path, 1);
    return window.__buildMarkdown(v.file, annots, "").split("\n").slice(0, 24);
  });
  report(
    "英文导出的 Markdown 用英文标签",
    enMd.some((l) => /annotations/.test(l)) && enMd.some((l) => /^(# |## )/.test(l)),
    JSON.stringify(enMd.slice(0, 8))
  );

  const backZh = await page.evaluate(() => {
    window.setLang("zh");
    const rail = Array.from(document.querySelectorAll(".pdfann-tool-label")).map((e) => e.textContent);
    return { rail, tabs: Array.from(document.querySelectorAll(".pdfann-tab")).map((e) => e.textContent) };
  });
  report(
    "切回中文立即恢复",
    backZh.rail.includes("画笔") && backZh.rail.includes("文字") && backZh.tabs.includes("批注"),
    JSON.stringify(backZh)
  );

  const auto = await page.evaluate(() => {
    const keep = localStorage.getItem("language");
    const probe = (v) => {
      if (v === null) localStorage.removeItem("language");
      else localStorage.setItem("language", v);
      return window.__resolveLang("auto");
    };
    const out = {
      zhCN: probe("zh"),
      zhTW: probe("zh-TW"),
      en: probe("en"),
    };
    if (keep === null) localStorage.removeItem("language");
    else localStorage.setItem("language", keep);
    // 明确的设置项永远压过系统语言
    out.forcedEnWhileSystemZh = (localStorage.setItem("language", "zh"), window.__resolveLang("en"));
    out.forcedZhWhileSystemEn = (localStorage.setItem("language", "en"), window.__resolveLang("zh"));
    if (keep === null) localStorage.removeItem("language");
    else localStorage.setItem("language", keep);
    return out;
  });
  report(
    "语言「跟随系统」能识别中英文，手动选择优先",
    auto.zhCN === "zh" && auto.zhTW === "zh" && auto.en === "en" &&
      auto.forcedEnWhileSystemZh === "en" && auto.forcedZhWhileSystemEn === "zh",
    JSON.stringify(auto)
  );

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
