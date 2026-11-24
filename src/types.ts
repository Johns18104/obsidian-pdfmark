export const VIEW_TYPE_PDF = "pdfmark-view";

export interface Pt {
  x: number;
  y: number;
}

/** Axis aligned rect in PDF user space (origin bottom-left, unit = pt) */
export interface PRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AnnotType =
  | "highlight"
  | "underline"
  | "strike"
  | "ink"
  | "line"
  | "rect"
  | "ellipse"
  | "arrow"
  | "note"
  | "textbox";

interface BaseAnnot {
  id: string;
  page: number;
  type: AnnotType;
  created: number;
  updated: number;
}

export interface TextMark extends BaseAnnot {
  type: "highlight" | "underline" | "strike";
  color: string;
  rects: PRect[];
  text: string;
  note?: string;
}

export interface InkAnnot extends BaseAnnot {
  type: "ink";
  color: string;
  width: number;
  opacity: number;
  strokes: Pt[][];
}

export interface ShapeAnnot extends BaseAnnot {
  type: "line" | "rect" | "ellipse" | "arrow";
  color: string;
  width: number;
  p0: Pt;
  p1: Pt;
  fill?: string | null;
}

export interface NoteAnnot extends BaseAnnot {
  type: "note";
  color: string;
  pt: Pt;
  text: string;
  /** font size in PDF pt; older notes have no value and fall back to the default */
  size?: number;
}

export type Annot = TextMark | InkAnnot | ShapeAnnot | NoteAnnot | TextBoxAnnot;

/**
 * Free text placed directly on the page. Rendered with the device's own fonts,
 * so any script (Chinese, Japanese, Arabic…) works without bundling a font.
 * `pt` is the top-left corner in PDF user space; `w` is the wrap width in pt.
 */
export interface TextBoxAnnot extends BaseAnnot {
  type: "textbox";
  color: string;
  /** font size in PDF pt */
  size: number;
  pt: Pt;
  w: number;
  text: string;
  /** optional card background, e.g. "#fffbe6"; null = transparent */
  bg?: string | null;
}

export interface FileRecord {
  annots: Annot[];
  lastPage: number;
  scrollRatio: number;
  updated: number;
  /** crop box of the first page content, in PDF pt, used by "裁白边" */
  cropBox?: PRect | null;
}

export interface PluginSettings {
  takeOverPdf: boolean;
  nightMode: boolean;
  cropMargins: boolean;
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  highlighterWidth: number;
  shapeColor: string;
  shapeWidth: number;
  noteColor: string;
  noteSize: number;
  textColor: string;
  textSize: number;
  textWidth: number;
  defaultFitWidth: boolean;
  sidebarOpen: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  takeOverPdf: false,
  nightMode: false,
  cropMargins: false,
  penColor: "#e8453c",
  penWidth: 2,
  highlighterColor: "#ffe066",
  highlighterWidth: 14,
  shapeColor: "#f08c1a",
  shapeWidth: 1.6,
  noteColor: "#f2c200",
  noteSize: 11,
  textColor: "#1f2430",
  textSize: 12,
  textWidth: 220,
  defaultFitWidth: true,
  sidebarOpen: true,
};

export const PALETTE = [
  "#f2c200",
  "#f08c1a",
  "#e8453c",
  "#e8537a",
  "#8e6fd8",
  "#2f7fd8",
  "#2f9e68",
  "#1f2430",
];

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function rectFromPoints(a: Pt, b: Pt): PRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function hexToRgb01(hex: string): [number, number, number] {
  let h = (hex || "#000000").replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
