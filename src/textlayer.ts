import { PRect } from "./types";

export interface TextItemBox {
  str: string;
  bbox: PRect;
  eol?: boolean;
  /** font family reported by pdf.js, used to measure per-character advances */
  family?: string;
  /** font size in PDF units (already includes the page scale) */
  size?: number;
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

export async function getTextItems(page: any): Promise<TextItemBox[]> {
  const out: TextItemBox[] = [];
  let tc: any;
  try {
    tc = await page.getTextContent();
  } catch {
    return out;
  }
  const items = (tc && tc.items) || [];
  const styles = (tc && tc.styles) || {};
  for (const it of items) {
    const str = it.str;
    if (!str || !str.trim()) continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const scaleY = Math.hypot(tr[2], tr[3]) || 1;
    const h = (it.height || scaleY) as number;
    let w = (it.width || 0) as number;
    if (!w) {
      w = Math.max(1, str.length * h * 0.5);
    }
    const x = tr[4] as number;
    const yBase = tr[5] as number;
    const style = styles[it.fontName] || {};
    out.push({
      str,
      bbox: { x, y: yBase - h * 0.2, w, h: h * 1.04 },
      eol: !!it.hasEOL,
      family: style.fontFamily || "",
      size: h,
    });
  }
  return out;
}

export function boxIntersects(a: PRect, b: PRect, minRatio = 0.25) {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  if (ix <= 0) return false;
  const rw = ix / Math.min(a.w, b.w);
  if (rw < Math.min(0.92, minRatio)) return false;
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (iy <= 0) return false;
  const rh = iy / Math.min(a.h, b.h);
  if (rh >= 0.42) return true;
  // A flat drag across a line (the natural "underline it" gesture) covers only a
  // sliver of the text height — still accept it when it crosses the line's middle.
  return Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) <= b.h * 0.55;
}

function lineKey(b: PRect) {
  return b.y + b.h / 2;
}

export function mergeLines(items: TextItemBox[]): PRect[] {
  const sorted = items
    .slice()
    .sort((a, b) => lineKey(b.bbox) - lineKey(a.bbox) || a.bbox.x - b.bbox.x);
  const lines: TextItemBox[][] = [];
  for (const it of sorted) {
    const cy = lineKey(it.bbox);
    const line = lines[lines.length - 1];
    if (line) {
      const ref = line[line.length - 1].bbox;
      const tol = Math.max(2, it.bbox.h * 0.55);
      if (Math.abs(cy - lineKey(ref)) < tol) {
        line.push(it);
        continue;
      }
    }
    lines.push([it]);
  }
  const rects: PRect[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.bbox.x - b.bbox.x);
    let cur: PRect = { ...line[0].bbox };
    for (let i = 1; i < line.length; i++) {
      const b = line[i].bbox;
      const gap = b.x - (cur.x + cur.w);
      if (gap < Math.max(4, cur.h * 1.1)) {
        const right = Math.max(cur.x + cur.w, b.x + b.w);
        const bottom = Math.min(cur.y, b.y);
        const top = Math.max(cur.y + cur.h, b.y + b.h);
        cur = { x: cur.x, y: bottom, w: right - cur.x, h: top - bottom };
      } else {
        rects.push(cur);
        cur = { ...b };
      }
    }
    rects.push(cur);
  }
  return rects;
}

export function joinItems(items: TextItemBox[]): string {
  const sorted = items
    .slice()
    .sort((a, b) => lineKey(b.bbox) - lineKey(a.bbox) || a.bbox.x - b.bbox.x);
  let out = "";
  let prev: TextItemBox | null = null;
  for (const it of sorted) {
    if (prev) {
      const sameLine =
        !prev.eol && Math.abs(lineKey(prev.bbox) - lineKey(it.bbox)) < Math.max(2, it.bbox.h * 0.55);
      if (sameLine) {
        const gap = it.bbox.x - (prev.bbox.x + prev.bbox.w);
        const needSpace = gap > it.bbox.h * 0.16;
        const lastCh = out.slice(-1);
        const firstCh = it.str.slice(0, 1);
        if (needSpace && !CJK.test(lastCh) && !CJK.test(firstCh)) out += " ";
      } else {
        if (out.endsWith("-")) out = out.slice(0, -1);
        else out += "\n";
      }
    }
    out += it.str;
    prev = it;
  }
  return out.trim();
}

/** union bbox of all text items, used by "裁白边" */
export function contentBox(items: TextItemBox[], pageW: number, pageH: number): PRect | null {
  if (!items.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of items) {
    const b = it.bbox;
    if (b.w <= 0 || b.h <= 0) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!isFinite(x0)) return null;
  const padX = Math.max(10, (x1 - x0) * 0.02);
  const padY = Math.max(10, (y1 - y0) * 0.02);
  const r = {
    x: Math.max(0, x0 - padX),
    y: Math.max(0, y0 - padY),
    w: Math.min(pageW, x1 + padX) - Math.max(0, x0 - padX),
    h: Math.min(pageH, y1 + padY) - Math.max(0, y0 - padY),
  };
  if (r.w < pageW * 0.2 || r.h < pageH * 0.2) return null;
  return r;
}

// ---------------------------------------------------------------------------
// Character level selection
//
// pdf.js hands us one string + one bbox per text run, so a run is indivisible
// for it. Readers still expect to select half a line, so we slice every run
// into per-character boxes (width apportioned along the run) and keep them in
// reading order. A selection is then just a range of cell indices, which makes
// "start of the line / end of the line" natural and keeps one drag = one
// annotation even across many runs.
// ---------------------------------------------------------------------------

export interface SelCell {
  ch: string;
  rect: PRect;
  item: number;
  line: number;
}

export interface SelLine {
  start: number;
  end: number;
  y0: number;
  y1: number;
}

export interface TextLayout {
  cells: SelCell[];
  lines: SelLine[];
}

let measureCtx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number[] | null>();

/**
 * Per-character advance widths for a run, measured with the browser font.
 * Zero width characters (U+200B & friends) come out as 0, which is the whole
 * point: assuming equal widths shifts every following glyph by one cell.
 * Returns null outside a DOM (unit tests) or when measuring fails.
 */
function measureWidths(str: string, family: string, size: number): number[] | null {
  if (typeof document === "undefined" || !size) return null;
  const key = `${family}|${size.toFixed(2)}|${str}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;
  try {
    if (!measureCtx) {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      measureCtx = cv.getContext("2d");
    }
    if (!measureCtx) return null;
    measureCtx.font = `${size}px ${family || "sans-serif"}, sans-serif`;
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < str.length; i++) {
      const w = measureCtx.measureText(str[i]).width;
      out.push(w);
      sum += w;
    }
    if (sum <= 0) return null;
    const ok = out;
    if (widthCache.size > 3000) widthCache.clear();
    widthCache.set(key, ok);
    return ok;
  } catch {
    return null;
  }
}

function isSpace(ch: string) {
  return !ch || /\s/.test(ch);
}

export function buildLayout(items: TextItemBox[]): TextLayout {
  const layout: TextLayout = { cells: [], lines: [] };
  if (!items.length) return layout;

  // group into visual lines, top of the page first
  const sorted = items
    .slice()
    .sort((a, b) => lineKey(b.bbox) - lineKey(a.bbox) || a.bbox.x - b.bbox.x);
  const groups: TextItemBox[][] = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g) {
      const ref = g[g.length - 1].bbox;
      const tol = Math.max(2, it.bbox.h * 0.55);
      if (Math.abs(lineKey(it.bbox) - lineKey(ref)) < tol) {
        g.push(it);
        continue;
      }
    }
    groups.push([it]);
  }

  groups.forEach((g, lineIdx) => {
    g.sort((a, b) => a.bbox.x - b.bbox.x);
    const line: SelLine = { start: layout.cells.length, end: 0, y0: Infinity, y1: -Infinity };
    g.forEach((it, itemIdx) => {
      const b = it.bbox;
      const n = it.str.length;
      if (n <= 0) return;
      const raw = measureWidths(it.str, it.family || "", it.size || b.h);
      let widths: number[];
      if (raw && raw.length === n) {
        const sum = raw.reduce((a, v) => a + v, 0);
        const k = sum > 0 ? b.w / sum : 0;
        widths = raw.map((v) => v * k);
      } else {
        widths = new Array(n).fill(b.w / n);
      }
      let cursor = b.x;
      for (let k = 0; k < n; k++) {
        layout.cells.push({
          ch: it.str[k],
          rect: { x: cursor, y: b.y, w: widths[k], h: b.h },
          item: itemIdx,
          line: lineIdx,
        });
        cursor += widths[k];
      }
      line.y0 = Math.min(line.y0, b.y);
      line.y1 = Math.max(line.y1, b.y + b.h);
    });
    line.end = layout.cells.length;
    if (line.end > line.start) layout.lines.push(line);
  });

  return layout;
}

/** Nearest character cell to a point in PDF space; -1 when the page has no text. */
export function hitCell(layout: TextLayout, p: { x: number; y: number }): number {
  if (!layout.cells.length) return -1;

  let li = 0;
  let bestDy = Infinity;
  for (let i = 0; i < layout.lines.length; i++) {
    const L = layout.lines[i];
    const dy = p.y < L.y0 ? L.y0 - p.y : p.y > L.y1 ? p.y - L.y1 : 0;
    if (dy < bestDy - 0.01) {
      bestDy = dy;
      li = i;
    }
    if (bestDy === 0) break;
  }

  const L = layout.lines[li];
  let best = L.start;
  let bestDx = Infinity;
  for (let i = L.start; i < L.end; i++) {
    const r = layout.cells[i].rect;
    const dx = p.x < r.x ? r.x - p.x : p.x > r.x + r.w ? p.x - (r.x + r.w) : 0;
    if (dx < bestDx) {
      bestDx = dx;
      best = i;
      if (dx === 0) break;
    }
  }
  return best;
}

/** Whole word (or CJK run) around a cell, for double click. */
export function wordRange(layout: TextLayout, index: number): [number, number] {
  const cell = layout.cells[index];
  if (!cell) return [index, index];
  const line = layout.lines[cell.line];
  const wordy = !isSpace(cell.ch) && !/[，。、；：！？,.;:!?()\u005b\u005d{}《》「」“”"'—…]/.test(cell.ch);
  let s = index;
  let e = index;
  if (wordy) {
    while (
      s > line.start &&
      layout.cells[s - 1].item === cell.item &&
      !isSpace(layout.cells[s - 1].ch) &&
      !/[，。、；：！？,.;:!?()\u005b\u005d{}《》「」“”"'—…]/.test(layout.cells[s - 1].ch)
    ) {
      s--;
    }
    while (
      e + 1 < line.end &&
      layout.cells[e + 1].item === cell.item &&
      !isSpace(layout.cells[e + 1].ch) &&
      !/[，。、；：！？,.;:!?()\u005b\u005d{}《》「」“”"'—…]/.test(layout.cells[e + 1].ch)
    ) {
      e++;
    }
  }
  return [s, e];
}

export function rangeText(layout: TextLayout, a: number, b: number): string {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(layout.cells.length - 1, Math.max(a, b));
  let out = "";
  for (let i = lo; i <= hi; i++) {
    const cur = layout.cells[i];
    const prev = i > lo ? layout.cells[i - 1] : null;
    if (prev) {
      if (cur.line !== prev.line) {
        if (out.endsWith("-")) out = out.slice(0, -1);
        else out += "\n";
      } else {
        const gap = cur.rect.x - (prev.rect.x + prev.rect.w);
        if (gap > cur.rect.h * 0.16 && !CJK.test(prev.ch) && !CJK.test(cur.ch)) out += " ";
      }
    }
    out += cur.ch;
  }
  return out.replace(/[ \t]+/g, " ").trim();
}

/** Selection boxes, one per visual line segment, for painting and for /QuadPoints. */
export function rangeRects(layout: TextLayout, a: number, b: number): PRect[] {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(layout.cells.length - 1, Math.max(a, b));
  const out: PRect[] = [];
  let cur: PRect | null = null;
  let curLine = -1;
  for (let i = lo; i <= hi; i++) {
    const c = layout.cells[i];
    const r = c.rect;
    if (!cur || c.line !== curLine) {
      if (cur) out.push(cur);
      cur = { ...r };
      curLine = c.line;
      continue;
    }
    const gap = r.x - (cur.x + cur.w);
    if (gap < Math.max(4, cur.h * 1.1)) {
      const right = Math.max(cur.x + cur.w, r.x + r.w);
      const bottom = Math.min(cur.y, r.y);
      const top = Math.max(cur.y + cur.h, r.y + r.h);
      cur = { x: cur.x, y: bottom, w: right - cur.x, h: top - bottom };
    } else {
      out.push(cur);
      cur = { ...r };
    }
  }
  if (cur) out.push(cur);
  return out;
}
