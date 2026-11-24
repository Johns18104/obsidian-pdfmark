import {
  DataAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import {
  VIEW_TYPE_PDF,
  DEFAULT_SETTINGS,
  MAX_FONT_SIZE,
  MAX_PEN_WIDTH,
  MAX_SHAPE_WIDTH,
  MIN_FONT_SIZE,
  PluginData,
  PluginSettings,
} from "./types";
import { AnnotStore } from "./store";
import { PDFView } from "./view";
import { adoptNativePdfLeaves } from "./takeover";
import { LangSetting, setLanguage, t, tf } from "./i18n";

/** Only the filesystem adapters have a real resource URL; mobile ones do not. */
type AdapterWithResourcePath = DataAdapter & { getResourcePath?: (path: string) => string };

export default class PdfAnnotatorPlugin extends Plugin {
  data: PluginData = { settings: { ...DEFAULT_SETTINGS }, files: {}, crops: {} };
  store!: AnnotStore;
  declare settings: PluginSettings;

  async onload() {
    const raw = ((await this.loadData()) as Partial<PluginData> | null) ?? {};
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      files: raw.files ?? {},
      crops: raw.crops ?? {},
    };
    this.settings = this.data.settings;
    // Old data files may hold a stroke width or font size outside today's
    // slider range; pull them back in so the value shown is the value used.
    this.settings.shapeWidth = Math.min(MAX_SHAPE_WIDTH, Math.max(0.5, this.settings.shapeWidth));
    this.settings.noteSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, this.settings.noteSize));
    this.settings.textSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, this.settings.textSize));
    this.settings.penWidth = Math.min(MAX_PEN_WIDTH, Math.max(0.5, this.settings.penWidth));
    this.settings.highlighterWidth = Math.min(MAX_PEN_WIDTH, Math.max(0.5, this.settings.highlighterWidth));
    setLanguage(this.settings.language);
    this.store = new AnnotStore(this);

    this.registerView(VIEW_TYPE_PDF, (leaf: WorkspaceLeaf) => new PDFView(leaf, this));

    // Obsidian's own PDF viewer already owns the "pdf" extension, and its
    // ViewRegistry throws rather than overwrite it, so registerExtensions()
    // can never take over. Instead, catch a PDF as it opens in the built-in
    // viewer and swap that leaf over to our view. Registered unconditionally
    // so the setting can be switched on later without a plugin reload; every
    // call exits immediately while the setting is off.
    this.watchPdfOpens();

    this.addRibbonIcon("book-open", t("用 PDFmark 打开当前文件", "Open the current file with PDFmark"), () => this.openActivePdf());

    this.addCommand({
      id: "open-current-pdf",
      name: t("用 PDFmark 打开当前 PDF", "Open the current PDF with PDFmark"),
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension.toLowerCase() === "pdf") {
          if (!checking) void this.openPdf(file);
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "reload-current-pdf",
      name: t("重新加载当前 PDF 视图", "Reload the PDF view"),
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PDFView);
        if (view) {
          if (!checking) void view.loadPdf();
          return true;
        }
        return false;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension.toLowerCase() === "pdf") {
          menu.addItem((i) =>
            i.setTitle(t("用 PDFmark 打开", "Open with PDFmark")).setIcon("book-open").onClick(() => this.openPdf(file))
          );
        }
      })
    );

    this.addSettingTab(new PdfAnnotatorSettingTab(this));
  }

  onunload() {
    if (this.store) void this.store.flush();
    // Deliberately no detachLeavesOfType() here: Obsidian tears the view down
    // itself on disable, and detaching would send the leaf back to its default
    // location even when the user had moved it somewhere deliberate.
  }

  async persist() {
    await this.saveData(this.data);
  }

  async openPdf(file: TFile) {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_PDF, state: { file: file.path }, active: true });
  }

  private openActivePdf() {
    const file = this.app.workspace.getActiveFile();
    if (file && file.extension.toLowerCase() === "pdf") void this.openPdf(file);
    else new Notice(t("请先选中一个 PDF 文件", "Select a PDF file first"));
  }

  /**
   * Obsidian opens .pdf in its built-in viewer, whose view type is literally
   * "pdf". registerExtensions() cannot claim an extension that is already
   * registered (ViewRegistry throws), so the take-over has to happen after the
   * fact: let the built-in viewer attach, then swap the leaf's view for ours.
   * Restored tabs from the previous session never emit file-open, so the
   * layout-ready scan covers those.
   */
  private watchPdfOpens() {
    this.registerEvent(this.app.workspace.on("file-open", () => this.adoptPdf()));
    // On some paths the built-in view is attached a tick after the event.
    this.registerEvent(this.app.workspace.on("layout-change", () => this.adoptPdf()));
    this.app.workspace.onLayoutReady(() => this.adoptPdf());
  }

  /**
   * Swap every built-in PDF leaf over to our view, or only the one showing
   * `onlyPath`. Safe to call often: it does nothing when no such leaf exists,
   * and our own view type is not "pdf", so it cannot re-trigger itself.
   */
  adoptPdf(onlyPath?: string) {
    if (!this.settings.takeOverPdf) return;
    adoptNativePdfLeaves(this.app.workspace, VIEW_TYPE_PDF, onlyPath);
  }

  assetUrl(rel: string): string {
    const p = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/${rel}`);
    try {
      const adapter = this.app.vault.adapter as AdapterWithResourcePath;
      const url = adapter.getResourcePath?.(p);
      if (url) return url;
    } catch { /* ignore */ }
    return "";
  }

  async backupPdf(file: TFile, bytes: Uint8Array) {
    try {
      const adapter = this.app.vault.adapter;
      const dir = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/backups`);
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      // A Uint8Array view over a larger buffer must be copied out by its own
      // offset; writeBinary wants that contiguous ArrayBuffer.
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await adapter.writeBinary(`${dir}/${file.basename}-${stamp}.pdf`, buf);
    } catch (e) {
      console.warn("[pdfmark] backup failed", e);
    }
  }

  async saveSettings() {
    await this.persist();
  }

  /** Re-render the text of every open PDF view after a language switch. */
  applyLanguage() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF)) {
      const view = leaf.view;
      if (view instanceof PDFView) view.refreshLanguage();
    }
  }
}

export class PdfAnnotatorSettingTab extends PluginSettingTab {
  plugin: PdfAnnotatorPlugin;
  constructor(plugin: PdfAnnotatorPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName(t("语言", "Language")).setHeading();

    new Setting(containerEl)
      .setName(t("界面语言", "Interface language"))
      .setDesc(
        t(
          "默认跟随系统。切换后设置页与已打开的 PDF 立刻更新；命令面板与侧栏图标的名字需要重启 Obsidian 才会变。",
          "Follows the system by default. The settings page and open PDFs update right away; command palette and ribbon names change after restarting Obsidian."
        )
      )
      .addDropdown((d) => {
        d.addOption("auto", t("跟随系统", "Follow system"));
        d.addOption("zh", "中文");
        d.addOption("en", "English");
        d.setValue(this.plugin.settings.language || "auto");
        d.onChange(async (v) => {
          this.plugin.settings.language = v as LangSetting;
          setLanguage(this.plugin.settings.language);
          await this.plugin.saveSettings();
          this.plugin.applyLanguage();
          this.display();
        });
      });

    new Setting(containerEl).setName(t("打开方式", "How PDFs open")).setHeading();

    new Setting(containerEl)
      .setName(t("接管 .pdf 默认打开方式", "Take over .pdf by default"))
      .setDesc(
        t("开启后双击 PDF 会自动换成本插件的阅读视图（立即生效，已打开的 PDF 也会接手）。关闭时完全不影响其他 PDF 插件，可用右键菜单「用 PDFmark 打开」进入。", "Double-clicking a PDF switches it to PDFmark's reader right away, including PDFs that are already open. When off, other PDF plugins are untouched — use “Open with PDFmark” from the context menu.")
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.takeOverPdf).onChange(async (v) => {
          this.plugin.settings.takeOverPdf = v;
          await this.plugin.saveSettings();
          if (v) {
            this.plugin.adoptPdf();
            new Notice(t("已开启：打开 PDF 会用 PDFmark 显示", "On — PDFs open in PDFmark"));
          } else {
            new Notice(t("已关闭：新的 PDF 用 Obsidian 自带阅读器打开", "Off — new PDFs open in Obsidian's viewer"));
          }
        })
      );

    new Setting(containerEl).setName(t("阅读", "Reading")).setHeading();

    new Setting(containerEl)
      .setName(t("夜间反色", "Night mode"))
      .setDesc(t("把页面反色显示，适合暗光下长时间看（只影响显示，不改文件）。", "Invert the page for reading in low light. Display only — the file is untouched."))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.nightMode).onChange(async (v) => {
          this.plugin.settings.nightMode = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("默认适应宽度", "Fit width by default"))
      .setDesc(t("打开 PDF 时自动缩放到页面宽度。", "Zoom each page to the window width when it opens."))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.defaultFitWidth).onChange(async (v) => {
          this.plugin.settings.defaultFitWidth = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("画笔按住已有笔迹时拖动它", "Drag ink when the pen presses on it"))
      .setDesc(
        t("关闭（默认）：用画笔或荧光笔在已有笔迹上起笔，继续画在新的一笔里，和手写习惯一致。", "Off (default): with the pen or highlighter, pressing on an existing stroke starts a new stroke, so you can keep writing across an old line. ") +
          t("开启：按在离已有笔迹 4px 以内会拖动整条笔迹，不会新增笔画；想接着画就从空白处起笔。", "On: pressing within 4 px of a stroke drags the whole stroke and adds nothing; start from blank space to keep writing. ") +
          t("「选中」工具下任何情况下都能拖笔迹。", "The Select tool always drags ink, whatever this is set to.")
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.penDragInk).onChange(async (v) => {
          this.plugin.settings.penDragInk = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("显示右侧批注栏", "Show the annotation sidebar"))
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.sidebarOpen).onChange(async (v) => {
          this.plugin.settings.sidebarOpen = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName(t("数据", "Data")).setHeading();

    const info = containerEl.createDiv({ cls: "pdfann-settings-info" });
    const count = Object.keys(this.plugin.data.files || {}).length;
    info.setText(
      tf(
        "已记录 {0} 个文件的批注。批注只存在插件自己的 data.json 里，不写进 PDF，也不在你的笔记库里新增文件。当前版本 {1}。",
        "Annotations for {0} file(s). They live in the plugin's own data.json — nothing is written into your PDFs and no file is added to your vault. Version {1}.",
        count,
        this.plugin.manifest.version
      )
    );

    new Setting(containerEl)
      .setName(t("清除全部批注数据", "Clear all annotation data"))
      .setDesc(t("只清除本插件保存的批注，不会动任何 PDF 或笔记文件。", "Removes only the annotations this plugin stores. No PDF or note is touched."))
      .addButton((b) =>
        b
          .setButtonText(t("清除", "Clear"))
          .setWarning()
          .onClick(async () => {
            this.plugin.data.files = {};
            this.plugin.data.crops = {};
            await this.plugin.persist();
            new Notice(t("已清除", "Cleared"));
            this.display();
          })
      );
  }
}
