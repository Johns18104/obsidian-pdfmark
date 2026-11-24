import { PDFDocument, rgb, LineCapStyle, BlendMode } from "pdf-lib";
import { Annot, InkAnnot, NoteAnnot, ShapeAnnot, TextBoxAnnot, TextMark, hexToRgb01 } from "./types";
import { textToPng } from "./richtext";

function c(hex: string) {
  const [r, g, b] = hexToRgb01(hex);
  return rgb(r, g, b);
}

/**
 * Bake every annotation into the page content stream, so any PDF viewer
 * (Acrobat, Preview, Zotero, phone) shows them without this plugin.
 */
export async function burnAnnotations(bytes: Uint8Array, annots: Annot[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();

  for (const a of annots) {
    const page = pages[a.page - 1];
    if (!page) continue;
    const { height: pageH } = page.getSize();

    if (a.type === "highlight") {
      const m = a as TextMark;
      for (const r of m.rects) {
        page.drawRectangle({
          x: r.x,
          y: r.y,
          width: Math.max(0.6, r.w),
          height: Math.max(0.6, r.h),
          color: c(m.color),
          opacity: 0.34,
          blendMode: BlendMode.Multiply,
        });
      }
    } else if (a.type === "underline" || a.type === "strike") {
      const m = a as TextMark;
      for (const r of m.rects) {
        const y = m.type === "underline" ? r.y + Math.max(0.8, r.h * 0.12) : r.y + r.h / 2;
        page.drawLine({
          start: { x: r.x, y },
          end: { x: r.x + r.w, y },
          thickness: Math.max(0.8, r.h * 0.09),
          color: c(m.color),
          lineCap: LineCapStyle.Round,
        });
      }
    } else if (a.type === "ink") {
      const ink = a as InkAnnot;
      const thickness = Math.max(0.5, ink.width);
      for (const stroke of ink.strokes) {
        if (stroke.length === 1) {
          page.drawCircle({
            x: stroke[0].x,
            y: stroke[0].y,
            size: thickness / 2,
            color: c(ink.color),
            opacity: ink.opacity,
          });
          continue;
        }
        for (let i = 1; i < stroke.length; i++) {
          page.drawLine({
            start: { x: stroke[i - 1].x, y: stroke[i - 1].y },
            end: { x: stroke[i].x, y: stroke[i].y },
            thickness,
            color: c(ink.color),
            opacity: ink.opacity,
            lineCap: LineCapStyle.Round,
          });
        }
      }
    } else if (a.type === "rect") {
      const s = a as ShapeAnnot;
      const x = Math.min(s.p0.x, s.p1.x);
      const y = Math.min(s.p0.y, s.p1.y);
      page.drawRectangle({
        x,
        y,
        width: Math.abs(s.p1.x - s.p0.x),
        height: Math.abs(s.p1.y - s.p0.y),
        borderColor: c(s.color),
        borderWidth: Math.max(0.5, s.width),
      });
    } else if (a.type === "ellipse") {
      const s = a as ShapeAnnot;
      const cx = (s.p0.x + s.p1.x) / 2;
      const cy = (s.p0.y + s.p1.y) / 2;
      page.drawEllipse({
        x: cx,
        y: cy,
        xScale: Math.max(0.6, Math.abs(s.p1.x - s.p0.x) / 2),
        yScale: Math.max(0.6, Math.abs(s.p1.y - s.p0.y) / 2),
        borderColor: c(s.color),
        borderWidth: Math.max(0.5, s.width),
      });
    } else if (a.type === "line" || a.type === "arrow") {
      const s = a as ShapeAnnot;
      const th = Math.max(0.5, s.width);
      page.drawLine({
        start: { x: s.p0.x, y: s.p0.y },
        end: { x: s.p1.x, y: s.p1.y },
        thickness: th,
        color: c(s.color),
        lineCap: LineCapStyle.Round,
      });
      if (a.type === "arrow") {
        const ang = Math.atan2(s.p1.y - s.p0.y, s.p1.x - s.p0.x);
        const hl = Math.max(5, th * 4.2);
        for (const d of [Math.PI / 7, -Math.PI / 7]) {
          page.drawLine({
            start: { x: s.p1.x, y: s.p1.y },
            end: { x: s.p1.x - hl * Math.cos(ang + d), y: s.p1.y - hl * Math.sin(ang + d) },
            thickness: th,
            color: c(s.color),
            lineCap: LineCapStyle.Round,
          });
        }
      }
    } else if (a.type === "note") {
      // The body of a note is drawn on the page as real text, not as a sticky
      // note icon: readers that ignore /Text annotations still see it.
      const n = a as NoteAnnot;
      const size = 16;
      const x = Math.min(n.pt.x, page.getSize().width - size);
      page.drawRectangle({
        x,
        y: n.pt.y - size,
        width: size,
        height: size,
        color: c(n.color),
        opacity: 0.92,
        borderColor: rgb(0.1, 0.1, 0.1),
        borderWidth: 0.5,
      });
      const png = await textToPng(n.text || "", {
        size: 11,
        width: 210,
        color: "#1f2430",
        background: "rgba(255,255,255,0.92)",
      });
      if (png) {
        const img = await doc.embedPng(png.bytes);
        page.drawImage(img, { x: x + size, y: n.pt.y - png.h, width: png.w, height: png.h });
      }
    } else if (a.type === "textbox") {
      const t = a as TextBoxAnnot;
      const png = await textToPng(t.text || "", {
        size: Math.max(6, t.size),
        width: Math.max(40, t.w),
        color: t.color,
        background: t.bg || "rgba(255,255,255,0.86)",
      });
      if (png) {
        const img = await doc.embedPng(png.bytes);
        // pt is the top-left corner in PDF user space
        page.drawImage(img, { x: t.pt.x, y: t.pt.y - png.h, width: png.w, height: png.h });
      }
    }
  }

  return await doc.save();
}
