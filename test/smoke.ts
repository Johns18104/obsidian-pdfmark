import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { burnAnnotations } from "../src/burn";
import { mergeLines, joinItems, contentBox, boxIntersects } from "../src/textlayer";
import fs from "fs";

function fakeAnnots() {
  return [
    { id: "a1", page: 1, type: "highlight", color: "#f2c200", created: 1, updated: 1,
      rects: [{ x: 50, y: 500, w: 200, h: 12 }], text: "这是一段被高亮的文字", note: "我的批注" },
    { id: "a2", page: 1, type: "underline", color: "#2f7fd8", created: 1, updated: 1,
      rects: [{ x: 50, y: 470, w: 180, h: 12 }], text: "下划线" },
    { id: "a3", page: 1, type: "strike", color: "#e8453c", created: 1, updated: 1,
      rects: [{ x: 50, y: 440, w: 150, h: 12 }], text: "删除线" },
    { id: "a4", page: 1, type: "ink", color: "#e8453c", width: 2, opacity: 1, created: 1, updated: 1,
      strokes: [[{ x: 60, y: 400 }, { x: 90, y: 420 }, { x: 120, y: 395 }, { x: 150, y: 415 }]] },
    { id: "a5", page: 1, type: "ink", color: "#ffe066", width: 14, opacity: 0.32, created: 1, updated: 1,
      strokes: [[{ x: 60, y: 370 }, { x: 240, y: 370 }]] },
    { id: "a6", page: 1, type: "rect", color: "#f08c1a", width: 1.6, created: 1, updated: 1,
      p0: { x: 60, y: 300 }, p1: { x: 220, y: 340 } },
    { id: "a7", page: 1, type: "ellipse", color: "#2f9e68", width: 1.6, created: 1, updated: 1,
      p0: { x: 60, y: 220 }, p1: { x: 180, y: 280 } },
    { id: "a8", page: 1, type: "arrow", color: "#e8537a", width: 2, created: 1, updated: 1,
      p0: { x: 250, y: 220 }, p1: { x: 330, y: 300 } },
    { id: "a9", page: 1, type: "note", color: "#f2c200", created: 1, updated: 1,
      pt: { x: 320, y: 460 }, text: "便签内容" },
    { id: "a10", page: 2, type: "line", color: "#1f2430", width: 1.6, created: 1, updated: 1,
      p0: { x: 40, y: 40 }, p1: { x: 300, y: 40 } },
  ] as any[];
}

async function main() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([400, 600]);
    p.drawText("Page " + (i + 1) + " sample text for annotation", { x: 40, y: 520, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
  }
  const src = await doc.save();
  console.log("source pdf bytes:", src.length);

  const annots = fakeAnnots();
  const out = await burnAnnotations(src, annots);
  console.log("burned pdf bytes:", out.length);
  fs.writeFileSync("test/out.pdf", out);

  const check = await PDFDocument.load(out);
  console.log("reloaded ok, pages =", check.getPageCount());

  const items = [
    { str: "Hello", bbox: { x: 40, y: 520, w: 30, h: 12 } },
    { str: "world", bbox: { x: 72, y: 520, w: 32, h: 12 } },
    { str: "第二行", bbox: { x: 40, y: 500, w: 36, h: 12 } },
    { str: "中文", bbox: { x: 78, y: 500, w: 24, h: 12 } },
  ] as any;
  console.log("join:", JSON.stringify(joinItems(items)));
  console.log("mergeLines:", JSON.stringify(mergeLines(items)));
  console.log("contentBox:", JSON.stringify(contentBox(items, 400, 600)));
  console.log("intersect:", boxIntersects({ x: 30, y: 515, w: 100, h: 20 }, items[0].bbox, 0.28));
}
main().catch((e) => { console.error("FAILED", e); process.exit(1); });
