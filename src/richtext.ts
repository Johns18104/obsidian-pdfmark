/**
 * Text measurement, wrapping and rasterisation for free-text annotations.
 *
 * Font licensing: nothing is bundled. On screen the text uses the device's own
 * system fonts; when an annotation is burned into a PDF the very same text is
 * drawn on a canvas with those fonts and embedded as a PNG. Glyphs are rendered,
 * no font file is copied, so no font licence is redistributed with the plugin.
 */

/** System font stack, mirrors what the on-screen overlay uses. */
export const TEXT_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';

export const LINE_HEIGHT = 1.4;

let measureCtx: CanvasRenderingContext2D | null = null;
function ctxFor(size: number): CanvasRenderingContext2D | null {
  if (!measureCtx) {
    try {
      const c = document.createElement("canvas");
      measureCtx = c.getContext("2d");
    } catch (e) {
      measureCtx = null;
    }
  }
  if (measureCtx) measureCtx.font = `${size}px ${TEXT_FONT}`;
  return measureCtx;
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f\u3040-\u30ff]/;

/** Split into tokens so Latin words stay whole while CJK breaks per character. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of line) {
    if (/\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(" ");
    } else if (CJK.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Width of a single line in the same unit as `fontSize`. */
export function measureLine(str: string, fontSize: number): number {
  const ctx = ctxFor(fontSize);
  return ctx ? ctx.measureText(str).width : str.length * fontSize * 0.55;
}

/** Greedy word wrap. `fontSize` and `maxWidth` must use the same unit. */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const ctx = ctxFor(fontSize);
  const width = (s: string) => (ctx ? ctx.measureText(s).width : s.length * fontSize * 0.55);
  const lines: string[] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw) {
      lines.push("");
      continue;
    }
    let cur = "";
    for (const tok of tokenize(raw)) {
      const next = cur + tok;
      if (cur && width(next) > maxWidth) {
        lines.push(cur.replace(/\s+$/, ""));
        cur = tok === " " ? "" : tok;
      } else {
        cur = next;
      }
      // A single token wider than the box: hard-split it.
      while (width(cur) > maxWidth && cur.length > 1) {
        let cut = cur.length - 1;
        while (cut > 1 && width(cur.slice(0, cut)) > maxWidth) cut--;
        lines.push(cur.slice(0, cut));
        cur = cur.slice(cut);
      }
    }
    lines.push(cur.replace(/\s+$/, ""));
  }
  return lines.length ? lines : [""];
}

export interface TextLayoutBox {
  lines: string[];
  /** height of the whole block, in the same unit as fontSize */
  height: number;
  lineHeight: number;
  /** widest line, capped at the wrap width */
  width: number;
}

export function layoutText(text: string, fontSize: number, maxWidth: number): TextLayoutBox {
  const lines = wrapText(text, fontSize, maxWidth);
  const lineHeight = fontSize * LINE_HEIGHT;
  const width = Math.min(
    maxWidth,
    Math.max(fontSize * 0.8, ...lines.map((l) => measureLine(l, fontSize)))
  );
  return { lines, height: Math.max(lineHeight, lines.length * lineHeight), lineHeight, width };
}

function rgbOf(hex: string): { r: number; g: number; b: number; a: number } {
  let h = (hex || "#000000").replace("#", "").trim();
  if (h.startsWith("rgb")) {
    const m = h.match(/[\d.]+/g) || [];
    return { r: +m[0] || 0, g: +m[1] || 0, b: +m[2] || 0, a: m[3] === undefined ? 1 : +m[3] };
  }
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0, a: 1 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

export interface RasterOptions {
  /** font size in PDF pt */
  size: number;
  /** wrap width in PDF pt */
  width: number;
  color: string;
  background?: string | null;
  /** device pixel ratio for the render, default 4 (≈ 288 dpi) */
  scale?: number;
  padding?: number;
}

export interface RasterResult {
  bytes: Uint8Array;
  /** size in PDF pt */
  w: number;
  h: number;
}

/**
 * Render a text block into a transparent PNG at `scale` times the target size.
 * Returns null when the environment cannot draw (no canvas).
 */
export async function textToPng(text: string, opts: RasterOptions): Promise<RasterResult | null> {
  const scale = opts.scale ?? 4;
  const padPt = opts.padding ?? Math.max(2, opts.size * 0.35);
  const wrapPt = Math.max(opts.size * 2, opts.width);
  const box = layoutText(text, opts.size, wrapPt);
  const wPt = Math.min(wrapPt, box.width) + padPt * 2;
  const hPt = box.height + padPt * 2;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(wPt * scale));
  canvas.height = Math.max(2, Math.round(hPt * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.scale(scale, scale);
  if (opts.background) {
    const bg = rgbOf(opts.background);
    ctx.fillStyle = `rgba(${bg.r},${bg.g},${bg.b},${bg.a})`;
    ctx.fillRect(0, 0, wPt, hPt);
  }
  const fg = rgbOf(opts.color);
  ctx.fillStyle = `rgba(${fg.r},${fg.g},${fg.b},1)`;
  ctx.font = `${opts.size}px ${TEXT_FONT}`;
  ctx.textBaseline = "top";
  box.lines.forEach((line, i) => {
    if (line) ctx.fillText(line, padPt, padPt + i * box.lineHeight + (box.lineHeight - opts.size) / 2);
  });

  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, w: wPt, h: hPt };
}
