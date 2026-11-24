import { ItemView, TFile, ViewStateResult, WorkspaceLeaf, setIcon, Notice, Menu } from "obsidian";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import type { PDFDocumentProxy, PageViewport, RenderTask } from "pdfjs-dist";
// The root pdfjs-dist entry only re-exports some of its types; these two are
// only declared on the display/api module.
import type { DocumentInitParameters, RefProxy } from "pdfjs-dist/types/src/display/api";
import { PDF_WORKER_B64 } from "./worker-b64";
import { AnnotStore } from "./store";
import { arrowHead } from "./arrow";
import {
  Annot,
  InkAnnot,
  MAX_FONT_SIZE,
  MAX_PEN_WIDTH,
  MAX_SHAPE_WIDTH,
  MIN_FONT_SIZE,
  NoteAnnot,
  PALETTE,
  PRect,
  PluginSettings,
  Pt,
  ShapeAnnot,
  TEXT_RULE_WIDTH,
  TextBoxAnnot,
  TextMark,
  VIEW_TYPE_PDF,
  rectFromPoints,
  uid,
} from "./types";
import {
  buildLayout,
  contentBox,
  getTextItems,
  hitCell,
  rangeRects,
  rangeText,
  TextItemBox,
  TextLayout,
  wordRange,
} from "./textlayer";
import { burnAnnotations } from "./burn";
import { MemoryCMapReaderFactory, MemoryStandardFontDataFactory } from "./pdfres";
import { TEXT_FONT, layoutText } from "./richtext";
import { Pair, isEnglish, t, tf, tp } from "./i18n";
import { buildMarkdown } from "./exporter";
import { ConfirmModal, TextInputModal } from "./modal";

const WORKER_URL = (() => {
  try {
    const bin = atob(PDF_WORKER_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  } catch (e) {
    console.error("[pdfmark] worker init failed", e);
    return "";
  }
})();

/** Error → message, for the places that show a failure string to the user. */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e && "message" in e && typeof e.message === "string") return e.message;
  return typeof e === "string" ? e : "unknown error";
}

/**
 * Pointer events are coalesced by the browser; Chrome and Safari expose the
 * dropped samples through getCoalescedEvents(), Firefox has no such method.
 */
function coalesced(e: PointerEvent): PointerEvent[] {
  const all = (e as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] }).getCoalescedEvents?.();
  return all && all.length ? all : [e];
}

/**
 * The slice of the plugin a PDF view talks to. Declared structurally so view.ts
 * does not have to import main.ts (which imports view.ts).
 */
export interface ViewHost {
  store: AnnotStore;
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  assetUrl(rel: string): string;
  backupPdf(file: TFile, bytes: Uint8Array): Promise<void>;
}

/**
 * pdf.js returns coordinate conversions as [x, y] arrays (Util.applyTransform),
 * while older builds returned {x, y}. Normalise both so callers never see NaN.
 */
function toPt(p: unknown): Pt {
  if (Array.isArray(p)) return { x: Number(p[0]), y: Number(p[1]) };
  return p as Pt;
}

function vpPt(vp: PageViewport | null, x: number, y: number): Pt {
  if (!vp) return { x: 0, y: 0 };
  return toPt(vp.convertToViewportPoint(x, y));
}

function pdfPt(vp: PageViewport | null, x: number, y: number): Pt {
  if (!vp) return { x: 0, y: 0 };
  return toPt(vp.convertToPdfPoint(x, y));
}

function distToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

let workerConfigured = false;
function configureWorker(plugin: ViewHost) {
  if (workerConfigured) return;
  workerConfigured = true;
  if (!WORKER_URL) return;
  try {
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(WORKER_URL);
    return;
  } catch (e) {
    console.warn("[pdfmark] blob worker failed, trying file worker", e);
  }
  let fileUrl = "";
  try {
    fileUrl = plugin && plugin.assetUrl ? plugin.assetUrl("pdf.worker.min.js") : "";
  } catch { /* ignore */ }
  pdfjsLib.GlobalWorkerOptions.workerSrc = fileUrl || WORKER_URL;
}

export type Tool =
  | "select"
  | "pen"
  | "highlighter"
  | "eraser"
  | "line"
  | "rect"
  | "ellipse"
  | "arrow"
  | "note"
  | "textbox";

interface PageEl {
  num: number;
  frame: HTMLElement;
  inner: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  ink: HTMLCanvasElement;
  inkCtx: CanvasRenderingContext2D | null;
  svg: SVGSVGElement;
  draw: HTMLElement;
  viewport: PageViewport | null;
  w: number;
  h: number;
  rendered: boolean;
  rendering: boolean;
  task: RenderTask | null;
  items: TextItemBox[] | null;
  layout?: TextLayout | null;
}

/** What Obsidian persists for this view: just the file it was showing. */
interface PdfViewState extends Record<string, unknown> {
  file?: string;
}

/** The movable geometry of an annotation, in whatever shape that kind uses. */
type Geom = { strokes: Pt[][] } | { pt: Pt } | { p0: Pt; p1: Pt };

/** One bookmark of the PDF outline; only the fields the sidebar uses. */
interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

interface ToolDef {
  id: Tool;
  icon: string;
  /** [zh, en] — resolved when the rail is drawn, not at module load. */
  label: Pair;
  tag: Pair;
}

const TOOLS: ToolDef[] = [
  { id: "select", icon: "mouse-pointer", label: ["选中 / 划词", "Select / text"], tag: ["选中", "Select"] },
  { id: "pen", icon: "pencil", label: ["画笔", "Pen"], tag: ["画笔", "Pen"] },
  { id: "highlighter", icon: "highlighter", label: ["荧光笔", "Highlighter"], tag: ["荧光", "Marker"] },
  { id: "eraser", icon: "eraser", label: ["橡皮（整笔擦除）", "Eraser (whole stroke)"], tag: ["橡皮", "Eraser"] },
  { id: "line", icon: "minus", label: ["直线", "Line"], tag: ["直线", "Line"] },
  { id: "rect", icon: "square", label: ["方框", "Box"], tag: ["方框", "Box"] },
  { id: "ellipse", icon: "circle", label: ["椭圆", "Oval"], tag: ["椭圆", "Oval"] },
  { id: "arrow", icon: "arrow-up-right", label: ["箭头", "Arrow"], tag: ["箭头", "Arrow"] },
  { id: "note", icon: "sticky-note", label: ["便签", "Note"], tag: ["便签", "Note"] },
  { id: "textbox", icon: "type", label: ["文字批注", "Text"], tag: ["文字", "Text"] },
];

/** setIcon silently renders nothing when the icon name is unknown to this Obsidian build. */
function setToolIcon(host: HTMLElement, icon: string, fallback: string) {
  try {
    setIcon(host, icon);
  } catch { /* ignore */ }
  if (!host.childElementCount) host.setText(fallback);
}

export class PDFView extends ItemView {
  plugin: ViewHost;
  store: AnnotStore;
  settings: PluginSettings;

  file: TFile | null = null;
  pdfDoc: PDFDocumentProxy | null = null;
  pdfBytes: Uint8Array | null = null;
  numPages = 0;
  pageSizes: { w: number; h: number; rot: number }[] = [];
  pages: PageEl[] = [];

  scale = 1;
  tool: Tool = "select";
  currentPage = 1;
  selectedId: string | null = null;

  scrollEl!: HTMLElement;
  pagesEl!: HTMLElement;
  railEl!: HTMLElement;
  barEl!: HTMLElement;
  optsEl!: HTMLElement;
  sideEl!: HTMLElement;
  popupEl: HTMLElement | null = null;
  progressEl!: HTMLElement;
  optsLabelEl!: HTMLElement;
  emptyEl!: HTMLElement;

  pageInput!: HTMLInputElement;
  totalEl!: HTMLElement;
  zoomEl!: HTMLElement;

  private observer: IntersectionObserver | null = null;
  private saveTimer: number | null = null;
  private pageInputTimer: number | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** Snapshot taken when a slider drag starts, so the whole drag is one undo step. */
  private widthBaseline: string | null = null;
  private widthUndoPushed = false;
  private scrollTick = 0;
  private lastScrollTop = 0;
  private sideTab: "annots" | "outline" = "annots";

  constructor(leaf: WorkspaceLeaf, plugin: ViewHost) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
    this.settings = plugin.settings;
  }

  getViewType() {
    return VIEW_TYPE_PDF;
  }
  getIcon() {
    return "book-open";
  }
  getDisplayText() {
    return this.file ? this.file.basename : "PDFmark";
  }

  private uiReady = false;
  private pendingPath: string | null = null;

  async onOpen() {
    this.contentEl.addClass("pdfann-root");
    this.buildUI();
    this.uiReady = true;
    const path = this.pendingPath || this.getState().file;
    if (path) await this.openPath(path);
  }

  getState(): PdfViewState {
    const base = super.getState() as PdfViewState | null;
    return { ...base, file: this.file ? this.file.path : this.pendingPath || undefined };
  }

  async setState(state: unknown, result: ViewStateResult) {
    await super.setState(state, result);
    const file = (state as PdfViewState | null)?.file;
    if (file) {
      this.pendingPath = file;
      if (this.uiReady) await this.openPath(file);
    }
  }

  async openPath(path: string) {
    if (this.file && this.file.path === path && this.pdfDoc) return;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      this.file = f;
      await this.onLoadFile(f);
    }
  }

  async onClose() {
    this.flushSave();
    try {
      await this.store.flush();
    } catch { /* ignore */ }
    this.destroyPages();
    this.removePopup();
    if (this.pdfDoc) {
      try {
        void this.pdfDoc.destroy();
      } catch { /* ignore */ }
      this.pdfDoc = null;
    }
  }

  async onLoadFile(file: TFile) {
    if (file.extension.toLowerCase() !== "pdf") {
      new Notice(t("PDFmark 只处理 .pdf 文件", "PDFmark only works with .pdf files"));
      return;
    }
    this.file = file;
    await this.loadPdf();
  }

  private buildUI() {
    const root = this.contentEl;
    root.empty();

    this.barEl = root.createDiv("pdfann-bar");
    const main = root.createDiv("pdfann-main");
    this.railEl = main.createDiv("pdfann-rail");
    const body = main.createDiv("pdfann-body");
    this.scrollEl = body.createDiv("pdfann-scroll");
    this.pagesEl = this.scrollEl.createDiv("pdfann-pages");
    this.sideEl = body.createDiv("pdfann-side");
    this.optsEl = root.createDiv("pdfann-opts");
    this.progressEl = root.createDiv("pdfann-progress");
    this.emptyEl = root.createDiv("pdfann-empty-state");
    this.emptyEl.setText(t("右键一个 PDF 文件 →「用 PDFmark 打开」", "Right-click a PDF → “Open with PDFmark”"));

    this.buildBar();
    this.buildRail();
    this.buildOptions();

    this.scrollEl.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.registerDomEvent(this.scrollEl, "wheel", (ev: WheelEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey) {
        ev.preventDefault();
        this.setScale(this.scale * (ev.deltaY < 0 ? 1.08 : 1 / 1.08));
      }
    }, { passive: false });
    this.registerDomEvent(window, "resize", () => {
      if (this.settings.defaultFitWidth) this.fitWidth();
    });
    this.registerDomEvent(activeDocument, "keydown", (ev: KeyboardEvent) => this.onKey(ev));
    this.sideEl.toggleClass("is-hidden", !this.settings.sidebarOpen);
  }

  private buildBar() {
    const bar = this.barEl;
    bar.empty();

    const nav = bar.createDiv("pdfann-nav");
    const prev = nav.createEl("button", { cls: "pdfann-icon-btn", attr: { "aria-label": t("上一页", "Previous page") } });
    setIcon(prev, "chevron-left");
    prev.onclick = () => this.goPage(this.currentPage - 1);

    this.pageInput = nav.createEl("input", { cls: "pdfann-pageinput", type: "text" });
    this.pageInput.value = "1";
    this.pageInput.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const n = parseInt(this.pageInput.value, 10);
        if (!Number.isNaN(n)) this.goPage(n);
        this.pageInput.blur();
      }
    };
    this.pageInput.onblur = () => {
      const n = parseInt(this.pageInput.value, 10);
      if (!Number.isNaN(n)) this.goPage(n);
      else this.syncPageInput();
    };
    this.totalEl = nav.createSpan({ cls: "pdfann-total", text: "/ 0" });

    const next = nav.createEl("button", { cls: "pdfann-icon-btn", attr: { "aria-label": t("下一页", "Next page") } });
    setIcon(next, "chevron-right");
    next.onclick = () => this.goPage(this.currentPage + 1);

    const zoom = bar.createDiv("pdfann-zoom");
    const zo = zoom.createEl("button", { cls: "pdfann-icon-btn" });
    setIcon(zo, "zoom-out");
    zo.onclick = () => this.setScale(this.scale / 1.15);
    this.zoomEl = zoom.createSpan({ cls: "pdfann-zoomval", text: "100%" });
    const zi = zoom.createEl("button", { cls: "pdfann-icon-btn" });
    setIcon(zi, "zoom-in");
    zi.onclick = () => this.setScale(this.scale * 1.15);
    const fit = zoom.createEl("button", { cls: "pdfann-text-btn", text: t("适宽", "Fit") });
    fit.onclick = () => this.fitWidth();

    bar.createDiv("pdfann-spacer");

    const night = bar.createEl("button", { cls: "pdfann-icon-btn" + (this.settings.nightMode ? " is-on" : ""), attr: { "aria-label": t("夜间反色", "Night mode") } });
    setIcon(night, "moon");
    night.onclick = async () => {
      this.settings.nightMode = !this.settings.nightMode;
      night.toggleClass("is-on", this.settings.nightMode);
      this.applyNight();
      await this.plugin.saveSettings();
    };

    const crop = bar.createEl("button", { cls: "pdfann-icon-btn" + (this.settings.cropMargins ? " is-on" : ""), attr: { "aria-label": t("裁白边", "Crop margins") } });
    setIcon(crop, "crop");
    crop.onclick = async () => {
      this.settings.cropMargins = !this.settings.cropMargins;
      crop.toggleClass("is-on", this.settings.cropMargins);
      await this.plugin.saveSettings();
      if (this.settings.cropMargins && this.file && !this.store.hasCrops(this.file.path)) {
        await this.computeCrops();
      }
      await this.relayout(true);
    };

    const side = bar.createEl("button", { cls: "pdfann-icon-btn", attr: { "aria-label": t("侧栏", "Sidebar") } });
    setIcon(side, "panel-right");
    side.onclick = () => {
      this.settings.sidebarOpen = !this.settings.sidebarOpen;
      this.sideEl.toggleClass("is-hidden", !this.settings.sidebarOpen);
      void this.plugin.saveSettings();
      this.afterLayoutChange();
    };

    const more = bar.createEl("button", { cls: "pdfann-icon-btn", attr: { "aria-label": t("更多", "More") } });
    setIcon(more, "more-horizontal");
    more.onclick = (ev: MouseEvent) => this.openMenu(ev);
  }

  private openMenu(ev: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle(t("导出批注为 Markdown", "Export annotations to Markdown")).setIcon("file-text").onClick(() => this.exportMarkdown())
    );
    menu.addItem((i) =>
      i.setTitle(t("复制当前页引用", "Copy a citation for this page")).setIcon("quote").onClick(() => this.copyCitation())
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle(t("烧入 PDF（不可逆，自动备份）", "Burn into PDF (permanent, backs up first)")).setIcon("flame").onClick(() => this.burn())
    );
    menu.addItem((i) => i.setTitle(t("重置缩放", "Reset zoom")).setIcon("maximize").onClick(() => this.setScale(1)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(t("清除本页批注", "Clear annotations on this page")).setIcon("trash").onClick(() => this.clearPage()));
    menu.addItem((i) =>
      i.setTitle(t("清除全文批注", "Clear all annotations")).setIcon("trash-2").onClick(() => this.clearAll())
    );
    menu.showAtMouseEvent(ev);
  }

  private buildRail() {
    const rail = this.railEl;
    rail.empty();
    for (const def of TOOLS) {
      const b = rail.createEl("button", {
        cls: "pdfann-tool" + (this.tool === def.id ? " is-active" : ""),
        attr: { "aria-label": tp(def.label), "data-tool": def.id },
      });
      const ic = b.createSpan({ cls: "pdfann-tool-icon" });
      const tag = tp(def.tag);
      setToolIcon(ic, def.icon, tag.slice(0, 1));
      b.createSpan({ cls: "pdfann-tool-label", text: tag });
      b.onclick = () => this.setTool(def.id);
    }
    rail.createDiv("pdfann-rail-sep");
    const mkBtn = (icon: string, tag: string, label: string, fn: () => void) => {
      const b = rail.createEl("button", { cls: "pdfann-tool", attr: { "aria-label": label } });
      const ic = b.createSpan({ cls: "pdfann-tool-icon" });
      setToolIcon(ic, icon, tag);
      b.createSpan({ cls: "pdfann-tool-label", text: tag });
      b.onclick = fn;
    };
    mkBtn("undo-2", t("撤销", "Undo"), t("撤销", "Undo"), () => this.undo());
    mkBtn("redo-2", t("重做", "Redo"), t("重做", "Redo"), () => this.redo());
  }

  /** Re-render every piece of chrome after the language setting changed. */
  refreshLanguage() {
    if (!this.barEl) return;
    this.buildBar();
    this.totalEl.setText("/ " + (this.pdfDoc ? this.pdfDoc.numPages : 0));
    this.syncPageInput();
    this.buildRail();
    const lockBtn = this.railEl.querySelector('.pdfann-tool[data-tool="select"]');
    if (lockBtn) lockBtn.toggleClass("is-on", this.selectLock);
    this.buildOptions();
    this.emptyEl.setText(t("右键一个 PDF 文件 →「用 PDFmark 打开」", "Right-click a PDF → “Open with PDFmark”"));
    if (this.file) void this.renderSidebar();
    // Page canvases only carry artwork; repaint so hit-area titles follow suit.
    for (const pe of this.pages) if (pe.viewport) this.paintPage(pe);
  }

  // ---------------------------------------------------------------- loading

  async loadPdf() {
    if (!this.file) return;
    if (!this.pagesEl) {
      this.pendingPath = this.file.path;
      return;
    }
    if (!this.pagesEl) {
      this.pendingPath = this.file.path;
      return;
    }
    this.showProgress(t("正在打开 PDF…", "Opening PDF…"));
    configureWorker(this.plugin);
    this.destroyPages();
    this.pdfDoc = null;
    try {
      const buf = await this.app.vault.readBinary(this.file);
      this.pdfBytes = new Uint8Array(buf);
    } catch (e) {
      this.showProgress(t("读取文件失败：", "Could not read the file: ") + errText(e));
      return;
    }
    try {
      const params: DocumentInitParameters = {
        data: this.pdfBytes.slice(0),
        isEvalSupported: false,
        cMapPacked: true,
        useSystemFonts: true,
        // Resource data is bundled into main.js, so the reader keeps working
        // after a community-directory install (which only fetches the three
        // plugin files) and on fully offline devices.
        CMapReaderFactory: MemoryCMapReaderFactory,
        StandardFontDataFactory: MemoryStandardFontDataFactory,
      };
      this.pdfDoc = await pdfjsLib.getDocument(params).promise;
    } catch (e) {
      this.showProgress(t("PDF 解析失败：", "Could not open the PDF: ") + errText(e));
      return;
    }
    this.numPages = this.pdfDoc.numPages;
    this.totalEl.setText("/ " + this.numPages);
    this.pageSizes = await this.readAllSizes(this.numPages);

    const rec = this.store.get(this.file.path);
    this.scale = this.computeFitScale();
    this.buildPages();
    this.applyNight();
    void this.renderSidebar();
    this.showProgress("");
    if (this.emptyEl) this.emptyEl.addClass("is-hidden");
    this.syncPageInput();

    const target = Math.min(Math.max(rec.lastPage || 1, 1), this.numPages);
    window.requestAnimationFrame(() => {
      this.goPage(target, false);
      if (rec.scrollRatio > 0 && target === rec.lastPage) {
        const pe = this.pages[target - 1];
        if (pe) {
          const extra = Math.max(0, pe.frame.offsetHeight * (rec.scrollRatio || 0));
          this.scrollEl.scrollTop = pe.frame.offsetTop + extra;
        }
      }
    });
  }

  private async readAllSizes(n: number) {
    const out: { w: number; h: number; rot: number }[] = new Array<{ w: number; h: number; rot: number }>(n);
    const doc = this.pdfDoc;
    if (!doc) return out;
    let idx = 1;
    const worker = async () => {
      while (idx <= n) {
        const i = idx++;
        try {
          const p = await doc.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          out[i - 1] = { w: vp.width, h: vp.height, rot: p.rotate || 0 };
        } catch {
          out[i - 1] = { w: 595, h: 842, rot: 0 };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, n) }, worker));
    return out;
  }

  private computeFitScale() {
    const avail = Math.max(240, this.scrollEl.clientWidth - 48);
    let maxW = 0;
    for (const s of this.pageSizes) maxW = Math.max(maxW, s ? s.w : 0);
    if (!maxW) maxW = 595;
    return Math.min(4, Math.max(0.15, avail / maxW));
  }

  destroyPages() {
    this.removePopup();
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    for (const pe of this.pages) {
      if (pe.task) {
        try {
          pe.task.cancel();
        } catch { /* ignore */ }
      }
    }
    this.pages = [];
    if (this.pagesEl) this.pagesEl.empty();
  }

  private buildPages() {
    this.pagesEl.empty();
    this.pages = [];
    for (let i = 1; i <= this.numPages; i++) {
      const frame = this.pagesEl.createDiv("pdfann-page");
      frame.dataset.page = String(i);
      const inner = frame.createDiv("pdfann-page-inner");
      const canvas = inner.createEl("canvas", { cls: "pdfann-canvas" });
      const ink = inner.createEl("canvas", { cls: "pdfann-ink" });
      const draw = inner.createDiv("pdfann-draw");
      const svg = createSvg("svg");
      svg.classList.add("pdfann-svg");
      inner.appendChild(svg);

      const pe: PageEl = {
        num: i,
        frame,
        inner,
        canvas,
        ctx: canvas.getContext("2d"),
        ink,
        inkCtx: ink.getContext("2d"),
        svg,
        draw,
        viewport: null,
        w: 0,
        h: 0,
        rendered: false,
        rendering: false,
        task: null,
        items: null,
      };
      this.pages.push(pe);
      this.layoutPage(pe);
      this.attachPageEvents(pe);
    }

    if (!this.observer) {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (en.isIntersecting) {
              const el = en.target as HTMLElement;
              const n = parseInt(el.dataset.page || "0", 10);
              const pe = this.pages[n - 1];
              if (pe) void this.renderPage(pe);
            }
          }
        },
        { root: this.scrollEl, rootMargin: "800px 0px" }
      );
    }
    for (const pe of this.pages) this.observer.observe(pe.frame);
  }

  private layoutPage(pe: PageEl) {
    const size = this.pageSizes[pe.num - 1] || { w: 595, h: 842, rot: 0 };
    const crop = this.settings.cropMargins ? this.store.cropOf(this.file?.path || "", pe.num) : null;
    let fw = size.w;
    let fh = size.h;
    let ox = 0;
    let oy = 0;
    if (crop && crop.w > 20 && crop.h > 20 && size.rot % 360 === 0) {
      ox = crop.x;
      oy = size.h - (crop.y + crop.h);
      fw = crop.w;
      fh = crop.h;
    }
    pe.w = size.w;
    pe.h = size.h;
    pe.frame.style.width = Math.round(fw * this.scale) + "px";
    pe.frame.style.height = Math.round(fh * this.scale) + "px";
    pe.inner.style.width = Math.round(size.w * this.scale) + "px";
    pe.inner.style.height = Math.round(size.h * this.scale) + "px";
    pe.inner.style.left = Math.round(-ox * this.scale) + "px";
    pe.inner.style.top = Math.round(-oy * this.scale) + "px";
    pe.canvas.style.width = Math.round(size.w * this.scale) + "px";
    pe.canvas.style.height = Math.round(size.h * this.scale) + "px";
    pe.ink.style.width = Math.round(size.w * this.scale) + "px";
    pe.ink.style.height = Math.round(size.h * this.scale) + "px";
    pe.svg.setAttribute("width", String(Math.round(size.w * this.scale)));
    pe.svg.setAttribute("height", String(Math.round(size.h * this.scale)));
  }

  async renderPage(pe: PageEl) {
    if (pe.rendered || pe.rendering || !this.pdfDoc) return;
    pe.rendering = true;
    try {
      const page = await this.pdfDoc.getPage(pe.num);
      const viewport = page.getViewport({ scale: this.scale });
      pe.viewport = viewport;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const cw = Math.floor(viewport.width * dpr);
      const ch = Math.floor(viewport.height * dpr);
      pe.canvas.width = cw;
      pe.canvas.height = ch;
      pe.ink.width = cw;
      pe.ink.height = ch;
      if (pe.inkCtx) pe.inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ctx = pe.ctx;
      if (!ctx) return;
      const task = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      pe.task = task;
      await task.promise;
      pe.rendered = true;
      this.paintPage(pe);
    } catch (e) {
      if (e instanceof Error && e.name === "RenderingCancelledException") return;
      console.error("[pdfmark] render failed page", pe.num, e);
    } finally {
      pe.rendering = false;
      pe.task = null;
    }
  }

  // ---------------------------------------------------------------- layout / zoom

  async relayout(keepAnchor = true) {
    this.clearSelectionPreview();
    const anchor = keepAnchor ? this.getAnchor() : null;
    this.destroyPages();
    this.scale = this.computeFitScale();
    this.buildPages();
    this.applyNight();
    this.updateZoomLabel();
    if (anchor) window.requestAnimationFrame(() => this.restoreAnchor(anchor));
  }

  setScale(s: number) {
    const next = Math.min(6, Math.max(0.15, s));
    if (Math.abs(next - this.scale) < 0.001) return;
    this.clearSelectionPreview();
    const anchor = this.getAnchor();
    this.scale = next;
    for (const pe of this.pages) {
      if (pe.task) {
        try {
          pe.task.cancel();
        } catch { /* ignore */ }
      }
      pe.rendered = false;
      pe.rendering = false;
      pe.viewport = null;
      this.layoutPage(pe);
    }
    this.updateZoomLabel();
    window.requestAnimationFrame(() => {
      this.restoreAnchor(anchor);
      for (const pe of this.pages) {
        const r = pe.frame.getBoundingClientRect();
        if (r.bottom > -600 && r.top < window.innerHeight + 600) void this.renderPage(pe);
      }
    });
  }

  fitWidth() {
    const s = this.computeFitScale();
    if (Math.abs(s - this.scale) < 0.001) return;
    this.setScale(s);
  }

  private updateZoomLabel() {
    if (this.zoomEl) this.zoomEl.setText(Math.round(this.scale * 100) + "%");
  }

  private getAnchor() {
    const top = this.scrollEl.scrollTop + 4;
    for (const pe of this.pages) {
      const t = pe.frame.offsetTop;
      const h = pe.frame.offsetHeight || 1;
      if (top >= t && top < t + h) {
        return { page: pe.num, ratio: (top - t) / h };
      }
    }
    return { page: this.currentPage, ratio: 0 };
  }

  private restoreAnchor(a: { page: number; ratio: number }) {
    const pe = this.pages[a.page - 1];
    if (!pe) return;
    this.scrollEl.scrollTop = pe.frame.offsetTop + pe.frame.offsetHeight * a.ratio;
  }

  private afterLayoutChange() {
    if (this.settings.defaultFitWidth) this.fitWidth();
    else {
      for (const pe of this.pages) this.layoutPage(pe);
    }
  }

  private onScroll() {
    if (this.scrollTick) return;
    this.scrollTick = window.requestAnimationFrame(() => {
      this.scrollTick = 0;
      const a = this.getAnchor();
      if (a.page !== this.currentPage) {
        this.currentPage = a.page;
        this.syncPageInput();
        if (this.sideTab === "annots") void this.renderSidebar();
      }
      this.scheduleSave();
    });
  }

  goPage(n: number, save = true) {
    const page = Math.min(Math.max(1, n), this.numPages || 1);
    const pe = this.pages[page - 1];
    if (!pe) return;
    this.scrollEl.scrollTop = Math.max(0, pe.frame.offsetTop - 6);
    this.currentPage = page;
    this.syncPageInput();
    if (save) this.scheduleSave();
    void this.renderPage(pe);
  }

  private syncPageInput() {
    if (this.pageInput && activeDocument.activeElement !== this.pageInput) {
      this.pageInput.value = String(this.currentPage);
    }
  }

  private applyNight() {
    this.scrollEl.toggleClass("pdfann-night", !!this.settings.nightMode);
  }

  private showProgress(msg: string) {
    if (!this.progressEl) return;
    this.progressEl.setText(msg);
    this.progressEl.toggleClass("is-hidden", !msg);
  }

  // ---------------------------------------------------------------- coords

  private toPdf(pe: PageEl, cx: number, cy: number) {
    if (!pe.viewport) return { x: 0, y: 0 };
    const r = pe.inner.getBoundingClientRect();
    return pdfPt(pe.viewport, cx - r.left, cy - r.top);
  }

  private toScreen(pe: PageEl, p: { x: number; y: number }) {
    if (!pe.viewport) return { x: 0, y: 0 };
    const v = vpPt(pe.viewport, p.x, p.y);
    const r = pe.inner.getBoundingClientRect();
    return { x: v.x + r.left, y: v.y + r.top };
  }

  private screenRect(pe: PageEl, r: PRect) {
    const a = vpPt(pe.viewport, r.x, r.y);
    const b = vpPt(pe.viewport, r.x + r.w, r.y + r.h);
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
  }

  // ---------------------------------------------------------------- painting

  paintPage(pe: PageEl, vectorOnly = false) {
    if (!this.file) return;
    const annots = this.store.annotsOf(this.file.path, pe.num);
    while (pe.svg.firstChild) pe.svg.removeChild(pe.svg.firstChild);
    if (pe.inkCtx && !vectorOnly) {
      const c = pe.inkCtx.canvas;
      pe.inkCtx.save();
      pe.inkCtx.setTransform(1, 0, 0, 1, 0, 0);
      pe.inkCtx.clearRect(0, 0, c.width, c.height);
      pe.inkCtx.restore();
    }
    if (!pe.viewport) return;
    if (!vectorOnly) for (const a of annots) if (a.type === "ink") this.drawInk(pe, a);
    for (const a of annots) if (a.type !== "ink") this.drawVector(pe, a);
  }

  private drawInk(pe: PageEl, a: InkAnnot) {
    const ctx = pe.inkCtx;
    if (!ctx || !pe.viewport) return;
    const vp = pe.viewport;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = a.color;
    ctx.globalAlpha = a.opacity;
    const base = Math.max(0.4, a.width * this.scale);
    for (const stroke of a.strokes) {
      if (stroke.length < 2) {
        if (stroke.length === 1) {
          const p = vpPt(vp, stroke[0].x, stroke[0].y);
          ctx.beginPath();
          ctx.arc(p.x, p.y, base / 2, 0, Math.PI * 2);
          ctx.fillStyle = a.color;
          ctx.fill();
        }
        continue;
      }
      if (a.opacity < 1) {
        ctx.beginPath();
        for (let i = 0; i < stroke.length; i++) {
          const p = vpPt(vp, stroke[i].x, stroke[i].y);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else {
            const prev = vpPt(vp, stroke[i - 1].x, stroke[i - 1].y);
            ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + p.x) / 2, (prev.y + p.y) / 2);
          }
        }
        ctx.lineWidth = base;
        ctx.stroke();
      } else {
        for (let i = 1; i < stroke.length; i++) {
          const p0 = vpPt(vp, stroke[i - 1].x, stroke[i - 1].y);
          const p1 = vpPt(vp, stroke[i].x, stroke[i].y);
          ctx.beginPath();
          ctx.lineWidth = base;
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  private svgEl(tag: string, attrs: Record<string, string | number>) {
    const el = createSvg(tag as keyof SVGElementTagNameMap);
    for (const k in attrs) el.setAttribute(k, String(attrs[k]));
    return el;
  }

  private drawVector(pe: PageEl, a: Annot) {
    const vp = pe.viewport;
    const s = this.scale;
    const g = this.svgEl("g", {});
    pe.svg.appendChild(g);

    if (a.type === "highlight" || a.type === "underline" || a.type === "strike") {
      const mark = a;
      for (const r of mark.rects) {
        const sr = this.screenRect(pe, r);
        if (mark.type === "highlight") {
          g.appendChild(
            this.svgEl("rect", {
              x: sr.x,
              y: sr.y,
              width: sr.w,
              height: sr.h,
              rx: 2,
              fill: mark.color,
              opacity: 0.38,
            })
          );
        } else {
          // Sit the rule on the bottom edge of the text box (half above, half
          // below), so a thicker rule grows downward instead of eating into the
          // glyphs. Anchoring on the box, not on a pixel offset, also keeps the
          // screen and the burned PDF identical.
          const y = mark.type === "underline" ? sr.y + sr.h : sr.y + sr.h / 2;
          g.appendChild(
            this.svgEl("line", {
              x1: sr.x,
              y1: y,
              x2: sr.x + sr.w,
              y2: y,
              stroke: mark.color,
              "stroke-width": Math.max(1, TEXT_RULE_WIDTH * s),
              "stroke-linecap": "butt",
            })
          );
        }
      }
      return;
    }

    if (a.type === "note" || a.type === "textbox") {
      const isNote = a.type === "note";
      const text = a.text || "";
      const sizePt = isNote
        ? Math.max(6, a.size || this.settings.noteSize)
        : Math.max(6, a.size || this.settings.textSize);
      const wrapPt = isNote ? 210 : Math.max(40, a.w || this.settings.textWidth);
      const px = sizePt * s;
      const pad = px * 0.35;
      const box = layoutText(text, px, wrapPt * s);
      const wPx = box.width + pad * 2;
      const hPx = box.height + pad * 2;

      let xPx: number;
      let topPx: number;
      if (isNote) {
        const p = vpPt(vp, a.pt.x, a.pt.y);
        const pin = 16;
        const pinRect = this.svgEl("rect", {
          x: p.x - 2,
          y: p.y - pin + 2,
          width: pin,
          height: pin,
          rx: 3,
          fill: a.color,
          stroke: "rgba(0,0,0,.25)",
          "stroke-width": 0.5,
          class: "pdfann-note-mark",
        });
        g.appendChild(pinRect);
        xPx = p.x + pin;
        topPx = p.y - pin + 2;
      } else {
        const p = vpPt(vp, a.pt.x, a.pt.y);
        xPx = p.x;
        topPx = p.y;
      }

      const card = this.svgEl("g", { class: "pdfann-textcard" });
      card.appendChild(
        this.svgEl("rect", {
          x: xPx,
          y: topPx,
          width: wPx,
          height: hPx,
          rx: 3,
          fill: isNote ? "rgba(255,255,255,.92)" : "rgba(255,255,255,.86)",
          stroke: isNote ? a.color : "rgba(0,0,0,.18)",
          "stroke-width": 0.8,
        })
      );
      box.lines.forEach((line, i) => {
        if (!line) return;
        const t = this.svgEl("text", {
          x: xPx + pad,
          y: topPx + pad + i * box.lineHeight,
          "font-size": px,
          "font-family": TEXT_FONT,
          // A note's colour belongs to its pin and spine; the body stays dark,
          // otherwise a yellow note would render pale yellow text on white.
          fill: isNote ? "#1f2430" : a.color || "#1f2430",
          "dominant-baseline": "text-before-edge",
          "xml:space": "preserve",
        });
        t.textContent = line;
        card.appendChild(t);
      });
      if (isNote) {
        card.appendChild(
          this.svgEl("rect", {
            x: xPx,
            y: topPx,
            width: 2,
            height: hPx,
            fill: a.color,
          })
        );
      }
      const gg = this.svgEl("g", { class: "pdfann-hit" });
      gg.appendChild(card);
      gg.addEventListener("pointerdown", (ev: PointerEvent) => {
        if (!this.canGrab(a)) return;
        ev.stopPropagation();
        this.onTextDown(pe, a, ev);
      });
      gg.addEventListener("dblclick", (ev: MouseEvent) => {
        ev.stopPropagation();
        // The eraser removes on the first press; do not reopen a dead card.
        if (this.tool === "eraser") return;
        if (!this.store.annotsOf(this.file.path, pe.num).some((x) => x.id === a.id)) return;
        if (isNote) void this.editNote(a);
        else void this.editTextBox(a);
      });
      g.appendChild(gg);
      return;
    }

    const sh = a as ShapeAnnot;
    const p0 = this.toScreenIn(pe, sh.p0);
    const p1 = this.toScreenIn(pe, sh.p1);
    const w = Math.max(0.6, sh.width * s);
    const common: Record<string, string | number> = {
      stroke: sh.color,
      "stroke-width": w,
      fill: sh.fill || "none",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    };

    if (sh.type === "line" || sh.type === "arrow") {
      const head = sh.type === "arrow" ? arrowHead(p0, p1, w) : null;
      const shaftEnd = head ? head.shaftEnd : p1;
      const line = this.svgEl("line", {
        ...common,
        // The shaft of an arrow stops at the base of the head and uses a butt
        // cap: a round cap at the tip leaves a rounded nub in front of the
        // point, which becomes glaringly obvious once you zoom in.
        "stroke-linecap": head ? "butt" : "round",
        x1: p0.x,
        y1: p0.y,
        x2: shaftEnd.x,
        y2: shaftEnd.y,
      });
      g.appendChild(line);
      if (head) {
        g.appendChild(
          this.svgEl("polygon", {
            points: `${head.tip.x},${head.tip.y} ${head.baseL.x},${head.baseL.y} ${head.baseR.x},${head.baseR.y}`,
            fill: sh.color,
            stroke: sh.color,
            "stroke-width": Math.max(0.4, Math.min(w * 0.35, head.len * 0.12)),
            "stroke-linejoin": "round",
          })
        );
      }
    } else if (sh.type === "rect") {
      const r = this.normRect(p0, p1);
      const rect = this.svgEl("rect", { ...common, x: r.x, y: r.y, width: r.w, height: r.h, rx: 1 });
      g.appendChild(rect);
    } else {
      const r = this.normRect(p0, p1);
      const ellipse = this.svgEl("ellipse", {
        ...common,
        cx: r.x + r.w / 2,
        cy: r.y + r.h / 2,
        rx: Math.max(1, r.w / 2),
        ry: Math.max(1, r.h / 2),
      });
      g.appendChild(ellipse);
    }

    const hit = this.svgEl(sh.type === "line" || sh.type === "arrow" ? "line" : "rect", {
      ...(sh.type === "line" || sh.type === "arrow"
        ? { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y }
        : (() => {
            const r = this.normRect(p0, p1);
            return { x: r.x, y: r.y, width: r.w, height: r.h };
          })()),
      stroke: "transparent",
      "stroke-width": Math.max(12, w * 3),
      fill: "transparent",
      style:
        sh.type === "line" || sh.type === "arrow" ? "pointer-events:stroke" : "pointer-events:fill",
      class: "pdfann-hit",
    });
    hit.addEventListener("pointerdown", (ev: PointerEvent) => {
      if (!this.canGrab(sh)) return;
      // With a drawing tool armed, only the outline counts: otherwise a new box
      // could never be drawn inside an existing one.
      if (
        this.tool !== "select" &&
        !this.hitsPoint(sh, this.toPdf(pe, ev.clientX, ev.clientY), this.hitTol(6), true)
      ) {
        return;
      }
      ev.stopPropagation();
      this.onShapeDown(pe, sh, ev, "move");
    });
    g.appendChild(hit);

    if (this.selectedId === sh.id) {
      const r = this.normRect(p0, p1);
      g.appendChild(
        this.svgEl("rect", {
          x: r.x - 3,
          y: r.y - 3,
          width: r.w + 6,
          height: r.h + 6,
          fill: "none",
          stroke: "#2f7fd8",
          "stroke-width": 1,
          "stroke-dasharray": "4 3",
        })
      );
      const corners: [number, number, string][] = [
        [r.x - 3, r.y - 3, "nw"],
        [r.x + r.w + 3, r.y - 3, "ne"],
        [r.x - 3, r.y + r.h + 3, "sw"],
        [r.x + r.w + 3, r.y + r.h + 3, "se"],
      ];
      for (const [hx, hy, id] of corners) {
        if ((sh.type === "line" || sh.type === "arrow") && id !== "nw" && id !== "se") continue;
        const h = this.svgEl("rect", {
          x: hx - 4,
          y: hy - 4,
          width: 8,
          height: 8,
          fill: "#ffffff",
          stroke: "#2f7fd8",
          "stroke-width": 1,
          style: "cursor:pointer;pointer-events:all",
        });
        h.addEventListener("pointerdown", (ev: PointerEvent) => {
          ev.stopPropagation();
          this.onShapeDown(pe, sh, ev, id);
        });
        g.appendChild(h);
      }
    }
  }

  private toScreenIn(pe: PageEl, p: { x: number; y: number }) {
    return vpPt(pe.viewport, p.x, p.y);
  }

  private normRect(a: { x: number; y: number }, b: { x: number; y: number }) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
  }

  // ---------------------------------------------------------------- tools ui

  setTool(tool: Tool) {
    if (tool === "select" && this.tool === "select") {
      this.selectLock = !this.selectLock;
      new Notice(this.selectLock ? t("已锁定选中：拖动即可划选文字", "Selection locked: drag to select text") : t("已解锁：在触屏上拖动为滚动页面", "Unlocked: dragging scrolls the page on touch"));
    }
    this.tool = tool;
    this.selectedId = null;
    this.removePopup();
    this.clearSelectionPreview();
    this.railEl.querySelectorAll(".pdfann-tool[data-tool]").forEach((el) => {
      el.toggleClass("is-active", (el as HTMLElement).dataset.tool === tool);
    });
    const lockBtn = this.railEl.querySelector('.pdfann-tool[data-tool="select"]');
    if (lockBtn) lockBtn.toggleClass("is-on", this.selectLock);
    this.pagesEl.toggleClass("pdfann-draw-active", tool !== "select");
    this.pagesEl.toggleClass("pdfann-erase-active", tool === "eraser");
    this.pagesEl.toggleClass("pdfann-sel-lock", this.selectLock);
    this.updateOptions();
    for (const pe of this.pages) if (pe.viewport) this.paintPage(pe);
    this.scrollEl.focus();
  }

  private buildOptions() {
    const el = this.optsEl;
    el.empty();
    this.optsLabelEl = el.createSpan({ cls: "pdfann-opts-label", text: "" });
    const pal = el.createDiv("pdfann-palette");
    for (const c of PALETTE) {
      const d = pal.createDiv("pdfann-swatch");
      d.style.background = c;
      d.dataset.color = c;
      d.onclick = () => this.pickColor(c);
    }
    const wrap = el.createDiv("pdfann-width");
    wrap.createSpan({ cls: "pdfann-width-label", text: t("粗细", "Width") });
    const range = wrap.createEl("input", { type: "range", cls: "pdfann-range" });
    const [rMin, rMax, rStep] = this.sliderRange(null);
    range.min = rMin;
    range.max = rMax;
    range.step = rStep;
    (range).value = String(this.currentWidth());
    const val = wrap.createSpan({ cls: "pdfann-width-val", text: String(this.currentWidth()) });
    range.oninput = () => {
      const v = parseFloat((range).value);
      const shown = this.isFontSize() ? Math.round(v) : Math.round(v * 10) / 10;
      val.setText(String(shown));
      this.pickWidth(v);
    };
    // One slider drag = one undo entry: remember the state when the drag starts.
    const armUndo = () => {
      this.widthBaseline = this.snapshot();
      this.widthUndoPushed = false;
    };
    const disarmUndo = () => {
      this.widthBaseline = null;
      this.widthUndoPushed = false;
    };
    range.addEventListener("pointerdown", armUndo);
    range.addEventListener("focus", armUndo);
    range.addEventListener("pointerup", disarmUndo);
    range.addEventListener("blur", disarmUndo);
    const extra = el.createDiv("pdfann-opts-extra");
    const del = extra.createEl("button", { cls: "pdfann-text-btn", text: t("删除所选", "Delete selected") });
    del.onclick = () => this.deleteSelected();
    const clearInk = extra.createEl("button", { cls: "pdfann-text-btn", text: t("清除本页墨迹", "Clear ink on this page") });
    clearInk.onclick = () => this.clearPage("ink");
    this.updateOptions();
  }

  private currentColor() {
    switch (this.tool) {
      case "pen":
        return this.settings.penColor;
      case "highlighter":
        return this.settings.highlighterColor;
      case "note":
        return this.settings.noteColor;
      case "textbox":
        return this.settings.textColor;
      default:
        return this.settings.shapeColor;
    }
  }

  /** True when the slider means "font size" rather than "stroke width". */
  private isFontSize(a?: Annot | null) {
    const t = a ? a.type : this.tool;
    return t === "textbox" || t === "note";
  }

  /**
   * [min, max, step] of the size slider. Its meaning depends on what it edits:
   * font size for text and notes, stroke width for shapes and ink. Shape
   * strokes stop at 13 pt — anything thicker has no use on a page — while the
   * pen and highlighter keep their larger range.
   */
  private sliderRange(a?: Annot | null): [string, string, string] {
    const kind = a ? a.type : this.tool;
    if (kind === "textbox" || kind === "note") {
      return [String(MIN_FONT_SIZE), String(MAX_FONT_SIZE), "1"];
    }
    if (kind === "line" || kind === "rect" || kind === "ellipse" || kind === "arrow") {
      return ["0.5", String(MAX_SHAPE_WIDTH), "0.5"];
    }
    return ["0.5", String(MAX_PEN_WIDTH), "0.5"];
  }

  private currentWidth() {
    switch (this.tool) {
      case "pen":
        return this.settings.penWidth;
      case "highlighter":
        return this.settings.highlighterWidth;
      case "textbox":
        return this.settings.textSize;
      case "note":
        return this.settings.noteSize;
      default:
        return this.settings.shapeWidth;
    }
  }

  /** The slider value that represents the current selection (or tool default). */
  private widthOf(a: Annot | null): number {
    if (!a) return this.currentWidth();
    if (a.type === "textbox") return Math.max(6, a.size || this.settings.textSize);
    if (a.type === "note") return Math.max(6, a.size || this.settings.noteSize);
    // Text marks have no stroke width; ink and shapes do.
    if ("width" in a && typeof a.width === "number") return a.width;
    return this.currentWidth();
  }

  /** "第 3 页" / "page 3" — used in citations and the sidebar. */
  private pageLabel(page: number): string {
    return tf("第 {0} 页", "page {0}", page);
  }

  private updateOptions() {
    if (this.optsLabelEl) {
      const sel = this.selectedId ? this.selectedAnnot() : null;
      const def = TOOLS.find((x) => x.id === (sel ? sel.type : this.tool));
      const name = def ? tp(def.label) : t("已选中", "Selected");
      const short = name.split(" / ")[0];
      // A full-width space reads better next to Chinese, a normal one next to Latin.
      const gap = isEnglish() ? " " : "　";
      this.optsLabelEl.setText(sel ? tf("已选中{0}", "Selected: {0}", short) + gap : short + gap);
    }
    const color = this.selectedId ? this.selectedAnnot()?.color : this.currentColor();
    this.optsEl.querySelectorAll(".pdfann-swatch").forEach((el) => {
      el.toggleClass("is-active", (el as HTMLElement).dataset.color === color);
    });
    const selA = this.selectedId ? this.selectedAnnot() : null;
    const fontSize = this.isFontSize(selA);
    const wl = this.optsEl.querySelector(".pdfann-width-label");
    if (wl) wl.setText(fontSize ? t("字号", "Size") : t("粗细", "Width"));
    const showWidth = this.tool !== "select" || !!this.selectedId;
    this.optsEl.toggleClass("pdfann-hide-width", !showWidth);
    const range = this.optsEl.querySelector<HTMLInputElement>(".pdfann-range");
    if (range) {
      // A font size of 0.5 pt is meaningless, and 12 pt text needs more headroom
      // than a 2 pt pen stroke, so the scale changes with the current tool.
      const [min, max, step] = this.sliderRange(selA);
      if (range.min !== min) range.min = min;
      if (range.max !== max) range.max = max;
      if (range.step !== step) range.step = step;
      const w = this.widthOf(selA);
      if (typeof w === "number") {
        range.value = String(Math.min(Math.max(w, parseFloat(min)), parseFloat(max)));
        const v = this.optsEl.querySelector(".pdfann-width-val");
        if (v) v.setText(this.isFontSize(selA) ? String(Math.round(w)) : String(Math.round(w * 10) / 10));
      }
    }
    const del = this.optsEl.querySelector(".pdfann-opts-extra .pdfann-text-btn");
    if (del) (del as HTMLElement).toggleClass("is-hidden", !this.selectedId);
  }

  private selectedAnnot(): Annot | null {
    if (!this.selectedId || !this.file) return null;
    return this.store.find(this.file.path, this.selectedId);
  }

  private pickColor(c: string) {
    const sel = this.selectedAnnot();
    if (sel && "color" in sel) {
      this.pushUndo();
      sel.color = c;
      this.repaintAll();
      void this.renderSidebar();
    }
    switch (this.tool) {
      case "pen":
        this.settings.penColor = c;
        break;
      case "highlighter":
        this.settings.highlighterColor = c;
        break;
      case "note":
        this.settings.noteColor = c;
        break;
      case "textbox":
        this.settings.textColor = c;
        break;
      default:
        this.settings.shapeColor = c;
    }
    void this.plugin.saveSettings();
    this.updateOptions();
  }

  /** Keep a slider value inside the range that applies to the current target. */
  private clampSize(w: number, a?: Annot | null): number {
    const kind = a ? a.type : this.tool;
    if (kind === "textbox" || kind === "note") {
      return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, w));
    }
    if (kind === "line" || kind === "rect" || kind === "ellipse" || kind === "arrow") {
      return Math.min(MAX_SHAPE_WIDTH, Math.max(0.5, w));
    }
    return Math.min(MAX_PEN_WIDTH, Math.max(0.5, w));
  }

  private pickWidth(raw: number) {
    const sel = this.selectedAnnot();
    const w = this.clampSize(raw, sel);
    if (sel) {
      let changed = false;
      if (sel.type === "textbox" || sel.type === "note") {
        const a = sel;
        const cur = Math.max(6, a.size || (sel.type === "note" ? this.settings.noteSize : this.settings.textSize));
        if (Math.abs(cur - w) > 0.001) {
          a.size = w;
          a.updated = Date.now();
          changed = true;
        }
      } else if ("width" in sel && sel.width !== w) {
        sel.width = w;
        changed = true;
      }
      if (changed) {
        // Everything the drag produces collapses into the one snapshot taken
        // when the slider was grabbed.
        if (this.widthBaseline) {
          if (!this.widthUndoPushed) {
            this.pushSnapshot(this.widthBaseline);
            this.widthUndoPushed = true;
          }
        } else {
          this.pushUndo();
        }
        this.repaintAll();
        void this.renderSidebar();
        this.scheduleSave();
      }
    }
    // With something selected the slider edits that annotation only; the tool
    // defaults are for the next one. Otherwise changing a note would silently
    // rewrite the size of every note created afterwards.
    if (!sel) {
      switch (this.tool) {
        case "pen":
          this.settings.penWidth = w;
          break;
        case "highlighter":
          this.settings.highlighterWidth = w;
          break;
        case "textbox":
          this.settings.textSize = w;
          break;
        case "note":
          this.settings.noteSize = w;
          break;
        default:
          this.settings.shapeWidth = w;
      }
      void this.plugin.saveSettings();
    }
  }

  private deleteSelected() {
    if (!this.selectedId || !this.file) return;
    this.pushUndo();
    this.store.remove(this.file.path, this.selectedId);
    this.selectedId = null;
    this.repaintAll();
    void this.renderSidebar();
    this.scheduleSave();
  }

  private repaintAll() {
    for (const pe of this.pages) if (pe.viewport) this.paintPage(pe);
  }

  // ---------------------------------------------------------------- pointer

  private attachPageEvents(pe: PageEl) {
    // Listen on the wrapper, not on the draw layer: the SVG hit targets are
    // siblings of the draw layer, so a press on an annotation would otherwise
    // never reach the page-level dispatcher.
    pe.inner.addEventListener("pointerdown", (ev: PointerEvent) => this.onPointerDown(pe, ev));
  }

  /** Can the current tool pick this annotation up and drag it? */
  private canGrab(a: Annot): boolean {
    return this.tool === "select" || this.toolMatches(this.tool, a);
  }

  private onPointerDown(pe: PageEl, ev: PointerEvent) {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    if (!pe.viewport) {
      void this.renderPage(pe);
      return;
    }
    this.removePopup();
    this.clearSelectionPreview();
    const tool = this.tool;
    if (tool === "eraser") {
      this.startErase(pe, ev);
      return;
    }

    const at = this.toPdf(pe, ev.clientX, ev.clientY);

    if (tool === "select") {
      if (ev.pointerType === "touch" && !this.selectLock) return;
      // Shapes, notes and text boxes carry their own DOM hit targets, but ink
      // is painted on a canvas — and a note's pin is just a marker — so they
      // have to be hit-tested here. Text marks are excluded on purpose: dragging
      // a highlight would tear it away from the words it belongs to.
      const grabbed = this.hitAnnotAt(pe, at, this.hitTol(4), {
        filter: (a) => a.type !== "highlight" && a.type !== "underline" && a.type !== "strike",
      });
      if (grabbed) {
        if (grabbed.type === "note" || grabbed.type === "textbox") {
          this.onTextDown(pe, grabbed, ev);
        } else if (grabbed.type === "ink") {
          this.startTranslate(pe, grabbed, ev);
        } else {
          this.onShapeDown(pe, grabbed as ShapeAnnot, ev, "move");
        }
        return;
      }
      if (this.selectedId) {
        this.selectedId = null;
        this.updateOptions();
        this.paintPage(pe);
      }
      void this.startSelect(pe, ev);
      return;
    }

    // While a tool is active, pressing an existing annotation of that same kind
    // grabs it — drag moves it, a plain click still opens its editor — instead
    // of stacking a duplicate on top. Empty space keeps the tool's usual job.
    const grabbed = this.hitAnnotAt(pe, at, this.hitTol(this.grabTolerance(tool)), {
      outline: tool === "line" || tool === "arrow" || tool === "rect" || tool === "ellipse",
      filter: (a) =>
        this.toolMatches(tool, a) &&
        // With the pen or highlighter, pressing on existing ink usually means
        // "continue this stroke". Grabbing it is opt-in (settings toggle).
        !((tool === "pen" || tool === "highlighter") && a.type === "ink" && !this.settings.penDragInk),
    });
    if (grabbed) {
      if (grabbed.type === "note" || grabbed.type === "textbox") {
        this.onTextDown(pe, grabbed, ev);
      } else if (grabbed.type === "ink") {
        this.startTranslate(pe, grabbed, ev);
      } else {
        this.onShapeDown(pe, grabbed as ShapeAnnot, ev, "move");
      }
      return;
    }

    if (tool === "note") {
      void this.createNote(pe, ev);
      return;
    }
    if (tool === "textbox") {
      void this.createTextBox(pe, ev);
      return;
    }
    if (tool === "pen" || tool === "highlighter") {
      this.startInk(pe, ev);
      return;
    }
    this.startShape(pe, ev, tool);
  }

  /** Which annotation kind each tool creates — only that kind can be grabbed. */
  private toolMatches(tool: Tool, a: Annot): boolean {
    switch (tool) {
      case "pen":
      case "highlighter":
        return a.type === "ink";
      case "note":
        return a.type === "note";
      case "textbox":
        return a.type === "textbox";
      case "line":
      case "rect":
      case "ellipse":
      case "arrow":
        return a.type === tool;
      default:
        return false;
    }
  }

  /**
   * How far from an annotation still counts as "on it", in CSS px. Ink uses a
   * tight radius so a stroke that merely starts near another stroke keeps
   * drawing instead of hijacking it.
   */
  private grabTolerance(tool: Tool): number {
    if (tool === "pen" || tool === "highlighter") return 4;
    if (tool === "note" || tool === "textbox") return 3;
    return 6;
  }

  private hitTol(px: number): number {
    return px / Math.max(0.2, this.scale);
  }

  /** Topmost annotation under a page-space point, newest first. */
  private hitAnnotAt(
    pe: PageEl,
    p: Pt,
    tol: number,
    opts: { outline?: boolean; filter?: (a: Annot) => boolean } = {}
  ): Annot | null {
    if (!this.file) return null;
    const list = this.store.annotsOf(this.file.path, pe.num);
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      if (opts.filter && !opts.filter(a)) continue;
      if (this.hitsPoint(a, p, tol, !!opts.outline)) return a;
    }
    return null;
  }

  private hitsPoint(a: Annot, p: Pt, tol: number, outline: boolean): boolean {
    switch (a.type) {
      case "ink": {
        const ink = a;
        const w = Math.max(tol, (ink.width || 2) / 2);
        return ink.strokes.some((s) => {
          if (s.length === 1) return Math.hypot(s[0].x - p.x, s[0].y - p.y) < w;
          for (let i = 1; i < s.length; i++) if (distToSegment(p, s[i - 1], s[i]) < w) return true;
          return false;
        });
      }
      case "line":
      case "arrow": {
        const sh = a;
        return distToSegment(p, sh.p0, sh.p1) < Math.max(tol, sh.width || 1) * 1.4;
      }
      case "rect":
      case "ellipse": {
        const sh = a;
        const bb = rectFromPoints(sh.p0, sh.p1);
        if (!outline) {
          return (
            p.x >= bb.x - tol && p.x <= bb.x + bb.w + tol && p.y >= bb.y - tol && p.y <= bb.y + bb.h + tol
          );
        }
        const t = Math.max(tol, (sh.width || 1) * 1.5);
        if (p.x < bb.x - t || p.x > bb.x + bb.w + t || p.y < bb.y - t || p.y > bb.y + bb.h + t) return false;
        if (
          Math.abs(p.x - bb.x) < t ||
          Math.abs(p.x - (bb.x + bb.w)) < t ||
          Math.abs(p.y - bb.y) < t ||
          Math.abs(p.y - (bb.y + bb.h)) < t
        ) {
          return true;
        }
        if (a.type === "rect") return false;
        // Ellipse: distance to the curve itself, not to its bounding box.
        const rx = Math.max(0.5, bb.w / 2);
        const ry = Math.max(0.5, bb.h / 2);
        const v = ((p.x - (bb.x + rx)) / rx) ** 2 + ((p.y - (bb.y + ry)) / ry) ** 2;
        return Math.abs(Math.sqrt(v) - 1) * Math.min(rx, ry) < t;
      }
      case "note": {
        const b = this.noteBox(a);
        return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
      }
      case "textbox": {
        const b = this.textBoxBox(a);
        return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
      }
      default: {
        const m = a;
        return m.rects.some(
          (r) => p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol
        );
      }
    }
  }

  /** Marker pin plus its text card, in PDF user space. */
  private noteBox(n: NoteAnnot): PRect {
    const k = 1 / Math.max(0.2, this.scale);
    const pin = 16 * k;
    const text = layoutText(n.text || "", 11, 210);
    const pad = 11 * 0.35;
    return {
      x: n.pt.x - 2 * k,
      y: n.pt.y - pin + 2 * k - text.height - pad * 2,
      w: pin + text.width + pad * 2,
      h: pin + text.height + pad * 2,
    };
  }

  /** Text box card, in PDF user space (`pt` is its top-left corner). */
  private textBoxBox(t: TextBoxAnnot): PRect {
    const size = Math.max(6, t.size || this.settings.textSize);
    const wrap = Math.max(40, t.w || this.settings.textWidth);
    const text = layoutText(t.text || "", size, wrap);
    const pad = size * 0.35;
    return {
      x: t.pt.x,
      y: t.pt.y - text.height - pad * 2,
      w: text.width + pad * 2,
      h: text.height + pad * 2,
    };
  }

  /**
   * Character-accurate selection. A selection is a range of character cells,
   * so it may start mid-line and end mid-line, and one drag is still one
   * annotation however many runs or lines it covers.
   */
  private async startSelect(pe: PageEl, ev: PointerEvent) {
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    // PointerEvent.detail is always 0 (only MouseEvent carries the click count),
    // so detect the double click ourselves.
    const now = Date.now();
    const dbl =
      now - this.lastSelDown.at < 380 &&
      Math.hypot(startX - this.lastSelDown.x, startY - this.lastSelDown.y) < 8;
    this.lastSelDown = { at: now, x: startX, y: startY };

    let layout: TextLayout | null = pe.layout || null;
    let anchor = -1;
    let focus = -1;
    let moved = false;

    const paint = () => {
      if (!layout || anchor < 0 || focus < 0) return;
      this.paintSelection(pe, rangeRects(layout, anchor, focus));
    };

    // Capture the whole gesture before awaiting the text layer: a fast click
    // would otherwise finish before we ever listened for pointerup.
    const drag = this.trackDrag(pe, ev, (x, y) => {
      if (Math.hypot(x - startX, y - startY) > 2) moved = true;
      if (!layout) return;
      if (anchor < 0) anchor = hitCell(layout, this.toPdf(pe, startX, startY));
      focus = hitCell(layout, this.toPdf(pe, x, y));
      paint();
    });

    try {
      const items = await this.getItems(pe);
      layout = pe.layout = buildLayout(items);
    } catch {
      layout = pe.layout = buildLayout([]);
    }

    const end = await drag;

    if (!layout || !layout.cells.length) {
      this.clearSelectionPreview();
      new Notice(t("这一页没有文字层（可能是扫描件），可用画笔或方框标注", "No text layer on this page (probably a scan) — use the pen or shapes"), 2600);
      return;
    }

    if (dbl && !moved) {
      const i = hitCell(layout, this.toPdf(pe, startX, startY));
      if (i < 0) {
        this.clearSelectionPreview();
        return;
      }
      const [a, b] = wordRange(layout, i);
      this.paintSelection(pe, rangeRects(layout, a, b));
      this.showTextPopup(pe, pe.num, rangeRects(layout, a, b), rangeText(layout, a, b), end.x, end.y);
      return;
    }

    if (!moved) {
      this.clearSelectionPreview();
      return;
    }

    if (anchor < 0) anchor = hitCell(layout, this.toPdf(pe, startX, startY));
    focus = hitCell(layout, this.toPdf(pe, end.x, end.y));
    paint();

    const rects = rangeRects(layout, anchor, focus);
    const text = rangeText(layout, anchor, focus);
    if (!rects.length || !text) {
      this.clearSelectionPreview();
      new Notice(t("没有选中文字，换个位置拖选试试", "No text selected — try dragging elsewhere"), 2200);
      return;
    }
    this.showTextPopup(pe, pe.num, rects, text, end.x, end.y);
  }

  private selPreviewEl: HTMLElement | null = null;
  private lastSelDown = { at: 0, x: 0, y: 0 };

  /** Live/persistent highlight of the current character range. */
  private paintSelection(pe: PageEl, rects: PRect[]) {
    if (!this.selPreviewEl || this.selPreviewEl.parentElement !== pe.inner) {
      this.clearSelectionPreview();
      const el = createDiv("pdfann-selpreview");
      pe.inner.appendChild(el);
      this.selPreviewEl = el;
    }
    const el = this.selPreviewEl;
    el.textContent = "";
    for (const rr of rects) {
      const sr = this.screenRect(pe, rr);
      const d = createDiv("pdfann-selrect");
      d.style.left = sr.x + "px";
      d.style.top = sr.y + "px";
      d.style.width = sr.w + "px";
      d.style.height = sr.h + "px";
      el.appendChild(d);
    }
  }

  private clearSelectionPreview() {
    if (this.selPreviewEl) {
      this.selPreviewEl.remove();
      this.selPreviewEl = null;
    }
  }

  /** Resolves on pointerup with the final client position; hooks every move. */
  private trackDrag(
    pe: PageEl,
    ev: PointerEvent,
    onMove: (x: number, y: number) => void
  ): Promise<{ x: number; y: number }> {
    const layer = pe.draw;
    return new Promise((resolve) => {
      let last = { x: ev.clientX, y: ev.clientY };
      const mv = (e: PointerEvent) => {
        last = { x: e.clientX, y: e.clientY };
        onMove(last.x, last.y);
      };
      const end = (e: PointerEvent) => {
        layer.removeEventListener("pointermove", mv);
        layer.removeEventListener("pointerup", end);
        layer.removeEventListener("pointercancel", end);
        try {
          layer.releasePointerCapture(ev.pointerId);
        } catch { /* ignore */ }
        if (e.type === "pointercancel") resolve(last);
        else resolve({ x: e.clientX, y: e.clientY });
      };
      try {
        layer.setPointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      layer.addEventListener("pointermove", mv);
      layer.addEventListener("pointerup", end);
      layer.addEventListener("pointercancel", end);
    });
  }

  private async getItems(pe: PageEl) {
    if (pe.items) return pe.items;
    try {
      const page = await this.pdfDoc.getPage(pe.num);
      pe.items = await getTextItems(page);
    } catch {
      pe.items = [];
    }
    return pe.items;
  }

  private showTextPopup(pe: PageEl, page: number, rects: PRect[], text: string, cx: number, cy: number) {
    this.removePopup();
    let color = this.settings.highlighterColor;
    const pop = createDiv("pdfann-popup");
    const preview = pop.createDiv("pdfann-popup-text");
    const flat = text.replace(/\s+/g, " ").trim();
    preview.setText(flat.length > 42 ? flat.slice(0, 42) + "…" : flat);
    preview.setAttribute("title", flat);
    const row = pop.createDiv("pdfann-popup-row");
    const mk = (label: string) => {
      const b = row.createEl("button", { cls: "pdfann-popbtn", text: label });
      return b;
    };
    const apply = (type: "highlight" | "underline" | "strike") => {
      this.pushUndo();
      const a: TextMark = {
        id: uid(),
        page,
        type,
        color,
        rects,
        text,
        created: Date.now(),
        updated: Date.now(),
      };
      this.store.add(this.file.path, a);
      this.paintPage(pe);
      void this.renderSidebar();
      this.scheduleSave();
      this.removePopup();
      this.clearSelectionPreview();
    };
    mk(t("高亮", "Highlight")).onclick = () => apply("highlight");
    mk(t("下划线", "Underline")).onclick = () => apply("underline");
    mk(t("删除线", "Strikethrough")).onclick = () => apply("strike");
    const noteBtn = mk(t("批注", "Note"));
    noteBtn.onclick = async () => {
      // Close the popup before the dialog appears: it floats above Obsidian's
      // modal layer, so it used to sit on top of the dialog's own 确定/取消
      // buttons — and every further click on 批注 started yet another note.
      if (this.noteBusy) return;
      this.noteBusy = true;
      this.removePopup();
      let note: string | null = null;
      try {
        note = await TextInputModal.open(this.app, t("添加批注", "Add note"), "");
      } finally {
        this.noteBusy = false;
      }
      if (!note || !note.trim()) {
        this.clearSelectionPreview();
        return;
      }
      this.pushUndo();
      const a: TextMark = {
        id: uid(),
        page,
        type: "highlight",
        color,
        rects,
        text,
        note,
        created: Date.now(),
        updated: Date.now(),
      };
      this.store.add(this.file.path, a);
      this.paintPage(pe);
      void this.renderSidebar();
      this.scheduleSave();
      this.clearSelectionPreview();
    };
    row.createDiv("pdfann-popup-sep");
    const colors = PALETTE.slice(0, 6);
    for (const c of colors) {
      const d = row.createDiv("pdfann-swatch pdfann-swatch-sm");
      d.style.background = c;
      if (c === color) d.addClass("is-active");
      d.onclick = () => {
        color = c;
        row.querySelectorAll(".pdfann-swatch").forEach((el) => el.removeClass("is-active"));
        d.addClass("is-active");
      };
    }
    row.createDiv("pdfann-popup-sep");
    mk(t("复制", "Copy")).onclick = () => {
      void navigator.clipboard.writeText(text);
      new Notice(t("已复制选中文字", "Selected text copied"));
      this.removePopup();
      this.clearSelectionPreview();
    };
    mk(t("引用", "Cite")).onclick = () => {
      const link = `[[${this.file.name}#page=${page}|${this.pageLabel(page)}]]`;
      void navigator.clipboard.writeText(`「${text}」（${link}）`);
      new Notice(t("已复制引用", "Citation copied"));
      this.removePopup();
      this.clearSelectionPreview();
    };
    activeDocument.body.appendChild(pop);

    // Drop the selection shading once the user clicks away from both the popup
    // and the page, so stale blue boxes never linger.
    const away = (e: Event) => {
      if (pop.contains(e.target as Node)) return;
      if (this.selPreviewEl && this.selPreviewEl.contains(e.target as Node)) return;
      this.clearSelectionPreview();
    };
    activeDocument.addEventListener("pointerdown", away, true);
    this.popupCleanup = () => activeDocument.removeEventListener("pointerdown", away, true);

    const rect = pop.getBoundingClientRect();
    let left = cx - rect.width / 2;
    let top = cy + 14;
    left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, left));
    if (top + rect.height > window.innerHeight - 8) top = cy - rect.height - 14;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    this.popupEl = pop;
  }

  private popupCleanup: (() => void) | null = null;
  /** A note dialog is open; ignore further clicks on the 批注 button. */
  private noteBusy = false;

  private removePopup() {
    if (this.popupCleanup) {
      this.popupCleanup();
      this.popupCleanup = null;
    }
    if (this.popupEl) {
      this.popupEl.remove();
      this.popupEl = null;
    }
  }

  private startInk(pe: PageEl, ev: PointerEvent) {
    ev.preventDefault();
    const layer = pe.draw;
    const isHi = this.tool === "highlighter";
    const pts: { x: number; y: number }[] = [];
    const pt = this.toPdf(pe, ev.clientX, ev.clientY);
    pts.push(pt);
    const ctx = pe.inkCtx;
    const color = isHi ? this.settings.highlighterColor : this.settings.penColor;
    const width = isHi ? this.settings.highlighterWidth : this.settings.penWidth;
    const opacity = isHi ? 0.32 : 1;
    const drawSeg = (e: PointerEvent) => {
      const p = this.toPdf(pe, e.clientX, e.clientY);
      const prev = pts[pts.length - 1];
      if (Math.hypot(p.x - prev.x, p.y - prev.y) * this.scale < 0.7) return;
      pts.push(p);
      if (!ctx) return;
      const a = vpPt(pe.viewport, prev.x, prev.y);
      const b = vpPt(pe.viewport, p.x, p.y);
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(0.5, width * this.scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    };
    const onMove = (e: PointerEvent) => {
      for (const ce of coalesced(e)) drawSeg(ce);
    };
    const finish = () => {
      layer.removeEventListener("pointermove", onMove);
      layer.removeEventListener("pointerup", finish);
      layer.removeEventListener("pointercancel", finish);
      try {
        layer.releasePointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      if (pts.length < 1) return;
      this.pushUndo();
      const a: InkAnnot = {
        id: uid(),
        page: pe.num,
        type: "ink",
        color,
        width,
        opacity,
        strokes: [pts],
        created: Date.now(),
        updated: Date.now(),
      };
      this.store.add(this.file.path, a);
      this.paintPage(pe);
      void this.renderSidebar();
      this.scheduleSave();
    };
    try {
      layer.setPointerCapture(ev.pointerId);
    } catch { /* ignore */ }
    layer.addEventListener("pointermove", onMove);
    layer.addEventListener("pointerup", finish);
    layer.addEventListener("pointercancel", finish);
  }

  private startErase(pe: PageEl, ev: PointerEvent) {
    const layer = pe.draw;
    let undoPushed = false;

    const hitTest = (p: Pt): Annot[] => {
      const tol = this.hitTol(9);
      return this.store.annotsOf(this.file.path, pe.num).filter((a) => this.hitsPoint(a, p, tol, false));
    };

    const eraseAt = (e: PointerEvent) => {
      const p = this.toPdf(pe, e.clientX, e.clientY);
      const hits = hitTest(p);
      if (!hits.length) return;
      if (!undoPushed) {
        this.pushUndo();
        undoPushed = true;
      }
      for (const a of hits) {
        this.store.remove(this.file.path, a.id);
        if (this.selectedId === a.id) this.selectedId = null;
      }
      this.paintPage(pe);
      void this.renderSidebar();
      this.scheduleSave();
    };

    eraseAt(ev);
    const onMove = (e: PointerEvent) => {
      for (const ce of coalesced(e)) eraseAt(ce);
    };
    const finish = () => {
      layer.removeEventListener("pointermove", onMove);
      layer.removeEventListener("pointerup", finish);
      layer.removeEventListener("pointercancel", finish);
      try {
        layer.releasePointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      if (undoPushed) this.updateOptions();
    };
    try {
      layer.setPointerCapture(ev.pointerId);
    } catch { /* ignore */ }
    layer.addEventListener("pointermove", onMove);
    layer.addEventListener("pointerup", finish);
    layer.addEventListener("pointercancel", finish);
  }

  private startShape(pe: PageEl, ev: PointerEvent, tool: ShapeAnnot["type"]) {
    ev.preventDefault();
    const layer = pe.draw;
    const p0 = this.toPdf(pe, ev.clientX, ev.clientY);
    const color = this.settings.shapeColor;
    const width = this.settings.shapeWidth;
    const preview = this.svgEl(tool === "line" || tool === "arrow" ? "line" : tool === "rect" ? "rect" : "ellipse", {
      stroke: color,
      "stroke-width": Math.max(1, width * this.scale),
      fill: "none",
      "stroke-linecap": "round",
      "pointer-events": "none",
    });
    pe.svg.appendChild(preview);
    let p1 = p0;
    const update = (e: PointerEvent) => {
      p1 = this.toPdf(pe, e.clientX, e.clientY);
      if (e.shiftKey && (tool === "line" || tool === "arrow")) {
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        p1 = { x: p0.x + Math.cos(ang) * len, y: p0.y + Math.sin(ang) * len };
      } else if (e.shiftKey) {
        const size = Math.max(Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y));
        p1 = { x: p0.x + Math.sign(p1.x - p0.x || 1) * size, y: p0.y + Math.sign(p1.y - p0.y || 1) * size };
      }
      const a = vpPt(pe.viewport, p0.x, p0.y);
      const b = vpPt(pe.viewport, p1.x, p1.y);
      if (tool === "line" || tool === "arrow") {
        preview.setAttribute("x1", String(a.x));
        preview.setAttribute("y1", String(a.y));
        preview.setAttribute("x2", String(b.x));
        preview.setAttribute("y2", String(b.y));
      } else {
        const r = this.normRect(a, b);
        preview.setAttribute("x", String(r.x));
        preview.setAttribute("y", String(r.y));
        preview.setAttribute("width", String(r.w));
        preview.setAttribute("height", String(r.h));
        if (tool === "ellipse") {
          preview.setAttribute("cx", String(r.x + r.w / 2));
          preview.setAttribute("cy", String(r.y + r.h / 2));
          preview.setAttribute("rx", String(r.w / 2));
          preview.setAttribute("ry", String(r.h / 2));
          preview.removeAttribute("x");
          preview.removeAttribute("y");
          preview.removeAttribute("width");
          preview.removeAttribute("height");
        }
      }
    };
    const finish = () => {
      layer.removeEventListener("pointermove", update);
      layer.removeEventListener("pointerup", finish);
      layer.removeEventListener("pointercancel", finish);
      try {
        layer.releasePointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      preview.remove();
      const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (dist * this.scale < 6) return;
      this.pushUndo();
      const a: ShapeAnnot = {
        id: uid(),
        page: pe.num,
        type: tool,
        color,
        width,
        p0,
        p1,
        created: Date.now(),
        updated: Date.now(),
      };
      this.store.add(this.file.path, a);
      this.setTool("select");
      this.selectedId = a.id;
      this.paintPage(pe);
      this.updateOptions();
      void this.renderSidebar();
      this.scheduleSave();
    };
    try {
      layer.setPointerCapture(ev.pointerId);
    } catch { /* ignore */ }
    layer.addEventListener("pointermove", update);
    layer.addEventListener("pointerup", finish);
    layer.addEventListener("pointercancel", finish);
  }

  private onShapeDown(pe: PageEl, sh: ShapeAnnot, ev: PointerEvent, mode: string) {
    ev.preventDefault();
    this.selectedId = sh.id;
    this.updateOptions();
    this.paintPage(pe, true);
    const layer = pe.draw;
    const startPt = this.toPdf(pe, ev.clientX, ev.clientY);
    const orig = { p0: { ...sh.p0 }, p1: { ...sh.p1 } };
    const before = this.snapshot();
    const bb = rectFromPoints(orig.p0, orig.p1);
    const onMove = (e: PointerEvent) => {
      const p = this.toPdf(pe, e.clientX, e.clientY);
      if (mode === "move") {
        const dx = p.x - startPt.x;
        const dy = p.y - startPt.y;
        sh.p0 = { x: orig.p0.x + dx, y: orig.p0.y + dy };
        sh.p1 = { x: orig.p1.x + dx, y: orig.p1.y + dy };
      } else if (mode === "p0" || mode === "p1") {
        if (mode === "p0") sh.p0 = p;
        else sh.p1 = p;
      } else {
        const anchor = {
          x: p.x < bb.x + bb.w / 2 ? bb.x + bb.w : bb.x,
          y: p.y < bb.y + bb.h / 2 ? bb.y + bb.h : bb.y,
        };
        const r = rectFromPoints(anchor, p);
        sh.p0 = { x: r.x, y: r.y };
        sh.p1 = { x: r.x + r.w, y: r.y + r.h };
      }
      this.paintPage(pe, true);
    };
    const finish = () => {
      layer.removeEventListener("pointermove", onMove);
      layer.removeEventListener("pointerup", finish);
      layer.removeEventListener("pointercancel", finish);
      try {
        layer.releasePointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      this.pushSnapshot(before);
      this.scheduleSave();
      void this.renderSidebar();
    };
    try {
      layer.setPointerCapture(ev.pointerId);
    } catch { /* ignore */ }
    layer.addEventListener("pointermove", onMove);
    layer.addEventListener("pointerup", finish);
    layer.addEventListener("pointercancel", finish);
  }

  /**
   * Drag a whole annotation. Shapes, notes and text boxes shift their anchor
   * points; ink shifts every point of every stroke, so a scribble moves as one
   * piece. A press without movement is not an edit, so no undo entry is made.
   */
  private startTranslate(pe: PageEl, a: Annot, ev: PointerEvent) {
    ev.preventDefault();
    const layer = pe.draw;
    const start = this.toPdf(pe, ev.clientX, ev.clientY);
    const before = this.snapshot();
    const orig = this.cloneGeom(a);
    let moved = false;
    const onMove = (e: PointerEvent) => {
      const p = this.toPdf(pe, e.clientX, e.clientY);
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (!moved && Math.hypot(dx, dy) * this.scale < 2) return;
      moved = true;
      this.translateFrom(a, orig, dx, dy);
      a.updated = Date.now();
      this.paintPage(pe, a.type !== "ink");
    };
    const finish = () => {
      layer.removeEventListener("pointermove", onMove);
      layer.removeEventListener("pointerup", finish);
      layer.removeEventListener("pointercancel", finish);
      try {
        layer.releasePointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      if (!moved) return;
      this.pushSnapshot(before);
      this.selectedId = a.id;
      this.paintPage(pe);
      this.updateOptions();
      void this.renderSidebar();
      this.scheduleSave();
    };
    try {
      layer.setPointerCapture(ev.pointerId);
    } catch { /* ignore */ }
    layer.addEventListener("pointermove", onMove);
    layer.addEventListener("pointerup", finish);
    layer.addEventListener("pointercancel", finish);
  }

  /** A copy of the geometry a drag has to move, in whichever shape it has. */
  private cloneGeom(a: Annot): Geom | null {
    if (a.type === "ink") return { strokes: a.strokes.map((s) => s.map((q) => ({ x: q.x, y: q.y }))) };
    if (a.type === "note" || a.type === "textbox") return { pt: { ...a.pt } };
    if (a.type === "line" || a.type === "rect" || a.type === "ellipse" || a.type === "arrow") {
      return { p0: { ...a.p0 }, p1: { ...a.p1 } };
    }
    return null;
  }

  private translateFrom(a: Annot, orig: Geom | null, dx: number, dy: number) {
    if (!orig) return;
    if (a.type === "ink" && "strokes" in orig) {
      a.strokes = orig.strokes.map((s) => s.map((q) => ({ x: q.x + dx, y: q.y + dy })));
    } else if ((a.type === "note" || a.type === "textbox") && "pt" in orig) {
      a.pt = { x: orig.pt.x + dx, y: orig.pt.y + dy };
    } else if ("p0" in orig && "p1" in orig && "p0" in a) {
      a.p0 = { x: orig.p0.x + dx, y: orig.p0.y + dy };
      a.p1 = { x: orig.p1.x + dx, y: orig.p1.y + dy };
    }
  }

  // ---------------------------------------------------------------- crops

  private async computeCrops() {
    if (!this.file || !this.pdfDoc) return;
    this.showProgress(t("正在分析页边距…", "Measuring margins…"));
    const n = this.numPages;
    let i = 1;
    const worker = async () => {
      while (i <= n) {
        const idx = i++;
        try {
          const page = await this.pdfDoc.getPage(idx);
          const vp = page.getViewport({ scale: 1 });
          const items = await getTextItems(page);
          this.store.setCrop(this.file.path, idx, contentBox(items, vp.width, vp.height));
        } catch { /* ignore */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, n) }, worker));
    this.store.save();
    this.showProgress("");
  }

  // ---------------------------------------------------------------- notes

  private async createNote(pe: PageEl, ev: PointerEvent) {
    const p = this.toPdf(pe, ev.clientX, ev.clientY);
    const text = await TextInputModal.open(this.app, t("添加批注", "Add note"), "");
    if (!text) return;
    this.pushUndo();
    const a: NoteAnnot = {
      id: uid(),
      page: pe.num,
      type: "note",
      color: this.settings.noteColor,
      pt: p,
      text,
      size: this.settings.noteSize,
      created: Date.now(),
      updated: Date.now(),
    };
    this.store.add(this.file.path, a);
    this.paintPage(pe);
    void this.renderSidebar();
    this.scheduleSave();
  }

  private async editNote(n: NoteAnnot) {
    const text = await TextInputModal.open(this.app, t("编辑批注", "Edit note"), n.text);
    if (text === null) return;
    this.pushUndo();
    if (!text.trim()) {
      this.store.remove(this.file.path, n.id);
    } else {
      n.text = text;
      n.updated = Date.now();
    }
    this.repaintAll();
    void this.renderSidebar();
    this.scheduleSave();
  }

  private async createTextBox(pe: PageEl, ev: PointerEvent) {
    const p = this.toPdf(pe, ev.clientX, ev.clientY);
    const vw = pe.viewport ? pe.viewport.width : 600;
    const vh = pe.viewport ? pe.viewport.height : 800;
    p.x = Math.max(4, Math.min(p.x, vw - 60));
    p.y = Math.min(p.y, vh - 30);
    const text = await TextInputModal.open(this.app, t("添加文字批注", "Add text"), "");
    if (!text || !text.trim()) return;
    this.pushUndo();
    const a: TextBoxAnnot = {
      id: uid(),
      page: pe.num,
      type: "textbox",
      color: this.settings.textColor,
      size: this.settings.textSize,
      pt: p,
      w: this.settings.textWidth,
      text,
      bg: null,
      created: Date.now(),
      updated: Date.now(),
    };
    this.store.add(this.file.path, a);
    this.paintPage(pe);
    void this.renderSidebar();
    this.scheduleSave();
  }

  private async editTextBox(a: TextBoxAnnot) {
    const text = await TextInputModal.open(this.app, t("编辑文字批注", "Edit text"), a.text);
    if (text === null) return;
    this.pushUndo();
    if (!text.trim()) {
      this.store.remove(this.file.path, a.id);
      this.selectedId = null;
    } else {
      a.text = text;
      a.updated = Date.now();
    }
    this.repaintAll();
    void this.renderSidebar();
    this.scheduleSave();
  }

  /** Click to edit, drag to move a note / text box. */
  private onTextDown(pe: PageEl, a: TextBoxAnnot | NoteAnnot, ev: PointerEvent) {
    ev.preventDefault();
    this.selectedId = a.id;
    this.updateOptions();
    const layer = pe.draw;
    const start = this.toPdf(pe, ev.clientX, ev.clientY);
    const orig = { x: a.pt.x, y: a.pt.y };
    const before = this.snapshot();
    let moved = false;
    const onMove = (e: PointerEvent) => {
      const p = this.toPdf(pe, e.clientX, e.clientY);
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 1.5) moved = true;
      if (!moved) return;
      a.pt = { x: orig.x + dx, y: orig.y + dy };
      a.updated = Date.now();
      this.paintPage(pe, true);
    };
    const finish = () => {
      layer.removeEventListener("pointermove", onMove);
      layer.removeEventListener("pointerup", finish);
      layer.removeEventListener("pointercancel", finish);
      try {
        layer.releasePointerCapture(ev.pointerId);
      } catch { /* ignore */ }
      if (moved) {
        this.pushSnapshot(before);
        this.scheduleSave();
        void this.renderSidebar();
        this.paintPage(pe);
      } else if (a.type === "note") {
        void this.editNote(a);
      } else {
        void this.editTextBox(a);
      }
    };
    try {
      layer.setPointerCapture(ev.pointerId);
    } catch { /* ignore */ }
    layer.addEventListener("pointermove", onMove);
    layer.addEventListener("pointerup", finish);
    layer.addEventListener("pointercancel", finish);
  }

  // ---------------------------------------------------------------- undo

  private snapshot() {
    return JSON.stringify(this.file ? this.store.annotsOf(this.file.path) : []);
  }

  private pushUndo() {
    this.pushSnapshot(this.snapshot());
  }

  private pushSnapshot(s: string) {
    if (this.undoStack[this.undoStack.length - 1] === s) return;
    this.undoStack.push(s);
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
  }

  private applySnapshot(s: string) {
    if (!this.file) return;
    try {
      this.store.replaceAnnots(this.file.path, JSON.parse(s) as Annot[]);
    } catch { /* ignore */ }
    this.selectedId = null;
    this.repaintAll();
    void this.renderSidebar();
    this.scheduleSave();
  }

  undo() {
    if (!this.undoStack.length) {
      new Notice(t("没有可撤销的操作", "Nothing to undo"));
      return;
    }
    this.redoStack.push(this.snapshot());
    this.applySnapshot(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) {
      new Notice(t("没有可重做的操作", "Nothing to redo"));
      return;
    }
    this.undoStack.push(this.snapshot());
    this.applySnapshot(this.redoStack.pop());
  }

  // ---------------------------------------------------------------- persistence

  scheduleSave() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), 700);
  }

  private lastSavedPage = -1;
  private lastSavedRatio = -1;

  flushSave() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.file) return;
    const a = this.getAnchor();
    if (a.page === this.lastSavedPage && Math.abs(a.ratio - this.lastSavedRatio) < 0.015) return;
    this.lastSavedPage = a.page;
    this.lastSavedRatio = a.ratio;
    this.store.touch(this.file.path, a.page, a.ratio);
    this.store.save();
  }

  // ---------------------------------------------------------------- sidebar

  private async renderSidebar() {
    if (!this.sideEl || !this.file) return;
    const side = this.sideEl;
    side.empty();
    const tabs = side.createDiv("pdfann-tabs");
    const t1 = tabs.createEl("button", {
      cls: "pdfann-tab" + (this.sideTab === "annots" ? " is-active" : ""),
      text: t("批注", "Notes"),
    });
    t1.onclick = () => {
      this.sideTab = "annots";
      void this.renderSidebar();
    };
    const t2 = tabs.createEl("button", {
      cls: "pdfann-tab" + (this.sideTab === "outline" ? " is-active" : ""),
      text: t("大纲", "Outline"),
    });
    t2.onclick = () => {
      this.sideTab = "outline";
      void this.renderSidebar();
    };

    const body = side.createDiv("pdfann-side-body");
    if (this.sideTab === "annots") {
      const annots = this.store.annotsOf(this.file.path).slice().sort((a, b) => a.page - b.page || a.created - b.created);
      if (!annots.length) {
        body.createDiv({
          cls: "pdfann-empty",
          text: t(
            "还没有批注。\n选中文字后可以高亮，或用画笔直接标注。",
            "No annotations yet.\nSelect text to highlight it, or draw with the pen."
          ),
        });
        const b = body.createEl("button", { cls: "pdfann-text-btn", text: t("导出为 Markdown 笔记", "Export as a Markdown note") });
        b.onclick = () => this.exportMarkdown();
        return;
      }
      const count = annots.length;
      const head = body.createDiv("pdfann-side-head");
      head.createSpan({ text: tf("{0} 条批注", "{0} annotations", count) });
      const ex = head.createEl("button", { cls: "pdfann-text-btn", text: t("导出", "Export") });
      ex.onclick = () => this.exportMarkdown();
      let lastPage = -1;
      for (const a of annots) {
        if (a.page !== lastPage) {
          body.createDiv({ cls: "pdfann-side-page", text: tf("第 {0} 页", "Page {0}", a.page) });
          lastPage = a.page;
        }
        const item = body.createDiv("pdfann-annot-item");
        item.onclick = () => {
          this.goPage(a.page);
          this.flash(a);
        };
        const dot = item.createDiv("pdfann-annot-dot");
        dot.style.background = "color" in a ? a.color || "#888" : "#888";
        const main = item.createDiv("pdfann-annot-main");
        const label: string = {
          highlight: t("高亮", "Highlight"),
          underline: t("下划线", "Underline"),
          strike: t("删除线", "Strikethrough"),
          ink: t("手写", "Ink"),
          line: t("直线", "Line"),
          rect: t("方框", "Box"),
          ellipse: t("椭圆", "Oval"),
          arrow: t("箭头", "Arrow"),
          note: t("便签", "Note"),
          textbox: t("文字", "Text"),
        }[a.type];
        const textEl = main.createDiv("pdfann-annot-text");
        textEl.setText(
          a.type === "ink"
            ? t("手写笔迹", "Ink stroke")
            : a.type === "note" || a.type === "textbox"
            ? a.text
            : "rects" in a && a.text
            ? a.text
            : label
        );
        if ("note" in a && a.note) {
          main.createDiv({ cls: "pdfann-annot-note", text: a.note });
        }
        main.createDiv({ cls: "pdfann-annot-meta", text: label });
        const del = item.createEl("button", { cls: "pdfann-annot-del" });
        setIcon(del, "x");
        del.onclick = (ev: MouseEvent) => {
          ev.stopPropagation();
          this.pushUndo();
          this.store.remove(this.file.path, a.id);
          this.repaintAll();
          void this.renderSidebar();
          this.scheduleSave();
        };
      }
    } else {
      const outline = await this.getOutline();
      if (!outline || !outline.length) {
        body.createDiv({ cls: "pdfann-empty", text: t("这份 PDF 没有书签目录。", "This PDF has no bookmarks.") });
        return;
      }
      const renderItems = (items: OutlineNode[], host: HTMLElement, depth: number) => {
        for (const it of items) {
          const row = host.createDiv("pdfann-outline-item");
          row.style.paddingLeft = 8 + depth * 12 + "px";
          row.setText(it.title || t("(无标题)", "(untitled)"));
          row.onclick = async () => {
            const page = await this.destToPage(it.dest);
            if (page) this.goPage(page);
          };
          if (it.items && it.items.length) renderItems(it.items, host, depth + 1);
        }
      };
      renderItems(outline, body, 0);
    }
  }

  private outlineCache: OutlineNode[] | null = null;

  private async getOutline(): Promise<OutlineNode[]> {
    if (this.outlineCache) return this.outlineCache;
    const doc = this.pdfDoc;
    try {
      this.outlineCache = doc ? (await doc.getOutline()) || [] : [];
    } catch {
      this.outlineCache = [];
    }
    return this.outlineCache;
  }

  /** A bookmark destination is either a named string or [pageRef, ...]. */
  private async destToPage(dest: string | unknown[] | null): Promise<number | null> {
    const doc = this.pdfDoc;
    if (!doc) return null;
    try {
      const target = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!target || !target.length) return null;
      const ref: unknown = target[0];
      if (typeof ref === "number") return ref + 1;
      if (ref && typeof ref === "object") {
        const idx = await doc.getPageIndex(ref as RefProxy);
        return idx + 1;
      }
      return null;
    } catch {
      return null;
    }
  }

  private flash(a: Annot) {
    const pe = this.pages[a.page - 1];
    if (!pe || !pe.viewport) return;
    const box = createDiv("pdfann-flash");
    let r: { x: number; y: number; w: number; h: number } | null = null;
    if ("rects" in a && a.rects?.length) {
      const rs = a.rects.map((x) => this.screenRect(pe, x));
      const x0 = Math.min(...rs.map((v) => v.x));
      const y0 = Math.min(...rs.map((v) => v.y));
      const x1 = Math.max(...rs.map((v) => v.x + v.w));
      const y1 = Math.max(...rs.map((v) => v.y + v.h));
      r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else if (a.type === "note") {
      const p = vpPt(pe.viewport, a.pt.x, a.pt.y);
      r = { x: p.x - 14, y: p.y - 32, w: 32, h: 32 };
    } else if ("strokes" in a) {
      const pts = a.strokes.reduce((acc, cur) => acc.concat(cur), [] as Pt[]);
      const sp = pts.map((p) => vpPt(pe.viewport, p.x, p.y));
      if (sp.length) {
        const x0 = Math.min(...sp.map((v) => v.x));
        const y0 = Math.min(...sp.map((v) => v.y));
        const x1 = Math.max(...sp.map((v) => v.x));
        const y1 = Math.max(...sp.map((v) => v.y));
        r = { x: x0 - 6, y: y0 - 6, w: x1 - x0 + 12, h: y1 - y0 + 12 };
      }
    } else if ("p0" in a) {
      const p0 = vpPt(pe.viewport, a.p0.x, a.p0.y);
      const p1 = vpPt(pe.viewport, a.p1.x, a.p1.y);
      r = { x: Math.min(p0.x, p1.x) - 6, y: Math.min(p0.y, p1.y) - 6, w: Math.abs(p1.x - p0.x) + 12, h: Math.abs(p1.y - p0.y) + 12 };
    }
    if (!r) return;
    box.style.left = r.x + "px";
    box.style.top = r.y + "px";
    box.style.width = r.w + "px";
    box.style.height = r.h + "px";
    pe.inner.appendChild(box);
    window.setTimeout(() => box.remove(), 1200);
  }

  // ---------------------------------------------------------------- actions

  private async copyCitation() {
    if (!this.file) return;
    const all = this.store.annotsOf(this.file.path).filter((a) => a.page === this.currentPage);
    const quoted = all.filter((a) => a.type === "highlight" || a.type === "underline" || a.type === "strike") as TextMark[];
    const link = `[[${this.file.name}#page=${this.currentPage}|${this.pageLabel(this.currentPage)}]]`;
    let body = "";
    if (quoted.length) {
      body = quoted.map((q) => tf("「{0}」（第 {1} 页）", "“{0}” (page {1})", q.text.trim(), q.page)).join("\n");
    } else {
      body = tf("（第 {0} 页）", "(page {0})", this.currentPage);
    }
    await navigator.clipboard.writeText(`${body}\n${link}`);
    new Notice(t("已复制引用", "Citation copied"));
  }

  private async exportMarkdown() {
    if (!this.file) return;
    const annots = this.store.annotsOf(this.file.path);
    if (!annots.length) {
      new Notice(t("这个 PDF 还没有批注", "This PDF has no annotations yet"));
      return;
    }
    const md = buildMarkdown(this.file, annots, this.pdfDoc ? this.file.basename : "");
    const base = this.file.path.replace(/\.pdf$/i, "") + t("（批注）", " (annotations)");
    let target = base + ".md";
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(target)) {
      target = `${base} ${i}.md`;
      i++;
    }
    const f = await this.app.vault.create(target, md);
    new Notice(t("已生成批注笔记：", "Annotation note created: ") + f.path);
    await this.app.workspace.getLeaf(true).openFile(f);
  }

  private async burn() {
    if (!this.file || !this.pdfBytes) return;
    const annots = this.store.annotsOf(this.file.path);
    if (!annots.length) {
      new Notice(t("没有可烧入的批注", "Nothing to burn"));
      return;
    }
    const ok = await ConfirmModal.open(
      this.app,
      tf("将 {0} 条批注写入 PDF？", "Burn {0} annotations into the PDF?", annots.length),
      t("批注会被合并进页面内容，任何阅读器都能看到，但之后无法再单独编辑。原文件会先备份到插件目录。", "Annotations become part of the page, so every reader shows them — but they can no longer be edited separately. The original file is backed up into the plugin folder first.")
    );
    if (!ok) return;
    this.showProgress(t("正在写入 PDF…", "Writing the PDF…"));
    try {
      const bytes = await burnAnnotations(this.pdfBytes, annots);
      await this.plugin.backupPdf(this.file, this.pdfBytes);
      // modifyBinary wants an ArrayBuffer, and slice() guarantees one that is
      // exactly the file length (a Uint8Array may be a view over a larger one).
      await this.app.vault.modifyBinary(this.file, bytes.slice().buffer);
      this.showProgress("");
      new Notice(t("已烧入 PDF（原文件已备份）", "Annotations burned in (original backed up)"));
      const clear = await ConfirmModal.open(this.app, t("清除插件内批注数据？", "Clear the plugin's copy of these annotations?"), t("批注已经写进 PDF，再保留一份会在阅读时重复显示。建议清除。", "They are now part of the PDF; keeping a copy would show them twice, so clearing is recommended."));
      if (clear) {
        this.pushUndo();
        this.store.replaceAnnots(this.file.path, []);
        this.store.save();
        void this.renderSidebar();
      }
      await this.loadPdf();
    } catch (e) {
      this.showProgress("");
      new Notice(t("写入失败：", "Write failed: ") + errText(e));
      console.error(e);
    }
  }

  private clearPage(kind?: "ink") {
    if (!this.file) return;
    const annots = this.store.annotsOf(this.file.path).filter(
      (a) => a.page === this.currentPage && (!kind || a.type === kind)
    );
    if (!annots.length) return;
    this.pushUndo();
    for (const a of annots) this.store.remove(this.file.path, a.id);
    this.repaintAll();
    void this.renderSidebar();
    this.scheduleSave();
  }

  private async clearAll() {
    if (!this.file) return;
    const n = this.store.annotsOf(this.file.path).length;
    if (!n) return;
    const ok = await ConfirmModal.open(
      this.app,
      tf("清除全部 {0} 条批注？", "Clear all {0} annotations?", n),
      t("此操作可以用撤销恢复。", "You can undo this.")
    );
    if (!ok) return;
    this.pushUndo();
    this.store.replaceAnnots(this.file.path, []);
    this.repaintAll();
    void this.renderSidebar();
    this.scheduleSave();
  }

  // ---------------------------------------------------------------- keys

  private onKey(ev: KeyboardEvent) {
    if (this.app.workspace.getActiveViewOfType(ItemView) !== this) return;
    const t = ev.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (this.popupEl) {
      if (ev.key === "Escape") {
        this.removePopup();
        ev.preventDefault();
      }
      return;
    }
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      if (ev.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && ev.key.toLowerCase() === "y") {
      ev.preventDefault();
      this.redo();
      return;
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      if (this.selectedId) {
        ev.preventDefault();
        this.deleteSelected();
      }
      return;
    }
    if (ev.key === "Escape") {
      this.setTool("select");
      return;
    }
    if (ev.key === "PageDown" || (ev.key === "ArrowRight" && !mod)) {
      ev.preventDefault();
      this.goPage(this.currentPage + 1);
    } else if (ev.key === "PageUp" || (ev.key === "ArrowLeft" && !mod)) {
      ev.preventDefault();
      this.goPage(this.currentPage - 1);
    }
  }

  // ---------------------------------------------------------------- state

  selectLock = false;
}
