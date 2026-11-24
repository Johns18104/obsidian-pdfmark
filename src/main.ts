import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import { VIEW_TYPE_PDF, DEFAULT_SETTINGS, PluginSettings } from "./types";
import { AnnotStore } from "./store";
import { PDFView } from "./view";

interface PluginData {
  settings: PluginSettings;
  files: Record<string, any>;
  crops: Record<string, any>;
}

export default class PdfAnnotatorPlugin extends Plugin {
  data: PluginData = { settings: { ...DEFAULT_SETTINGS }, files: {}, crops: {} };
  store!: AnnotStore;
  declare settings: PluginSettings;

  async onload() {
    const raw = (await this.loadData()) || {};
    this.data = {
      settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings || {}),
      files: raw.files || {},
      crops: raw.crops || {},
    };
    this.settings = this.data.settings;
    this.store = new AnnotStore(this);

    this.registerView(VIEW_TYPE_PDF, (leaf: WorkspaceLeaf) => new PDFView(leaf, this));

    if (this.settings.takeOverPdf) {
      try {
        this.registerExtensions(["pdf"], VIEW_TYPE_PDF);
      } catch (e) {
        console.error("[pdfmark] take over failed", e);
      }
    }

    this.addRibbonIcon("book-open", "用 PDFmark 打开当前文件", () => this.openActivePdf());

    this.addCommand({
      id: "open-current-pdf",
      name: "用 PDFmark 打开当前 PDF",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension.toLowerCase() === "pdf") {
          if (!checking) this.openPdf(file);
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "reload-current-pdf",
      name: "重新加载当前 PDF 视图",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PDFView);
        if (view) {
          if (!checking) view.loadPdf();
          return true;
        }
        return false;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension.toLowerCase() === "pdf") {
          menu.addItem((i) =>
            i.setTitle("用 PDFmark 打开").setIcon("book-open").onClick(() => this.openPdf(file))
          );
        }
      })
    );

    this.addSettingTab(new PdfAnnotatorSettingTab(this));
  }

  onunload() {
    if (this.store) this.store.flush();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_PDF);
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
    if (file && file.extension.toLowerCase() === "pdf") this.openPdf(file);
    else new Notice("请先选中一个 PDF 文件");
  }

  assetUrl(rel: string): string {
    const p = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/${rel}`);
    try {
      const adapter: any = this.app.vault.adapter;
      if (typeof adapter.getResourcePath === "function") {
        const url = adapter.getResourcePath(p);
        if (url) return url;
      }
    } catch (e) {}
    return "";
  }

  async backupPdf(file: TFile, bytes: Uint8Array) {
    try {
      const adapter: any = this.app.vault.adapter;
      const dir = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/backups`);
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const buf: any = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      await adapter.writeBinary(`${dir}/${file.basename}-${stamp}.pdf`, buf);
    } catch (e) {
      console.warn("[pdfmark] backup failed", e);
    }
  }

  async saveSettings() {
    await this.persist();
  }
}

class PdfAnnotatorSettingTab extends PluginSettingTab {
  plugin: PdfAnnotatorPlugin;
  constructor(plugin: PdfAnnotatorPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("打开方式").setHeading();

    new Setting(containerEl)
      .setName("接管 .pdf 默认打开方式")
      .setDesc(
        "开启后双击 PDF 直接用本插件打开，需要重启 Obsidian 生效。关闭时完全不影响其他 PDF 插件，可用右键菜单「用 PDFmark 打开」进入。"
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.takeOverPdf).onChange(async (v) => {
          this.plugin.settings.takeOverPdf = v;
          await this.plugin.saveSettings();
          new Notice(v ? "已开启，重启 Obsidian 后生效" : "已关闭，重启 Obsidian 后生效");
        })
      );

    new Setting(containerEl).setName("阅读").setHeading();

    new Setting(containerEl)
      .setName("夜间反色")
      .setDesc("把页面反色显示，适合暗光下长时间看（只影响显示，不改文件）。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.nightMode).onChange(async (v) => {
          this.plugin.settings.nightMode = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("默认适应宽度")
      .setDesc("打开 PDF 时自动缩放到页面宽度。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.defaultFitWidth).onChange(async (v) => {
          this.plugin.settings.defaultFitWidth = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("显示右侧批注栏")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.sidebarOpen).onChange(async (v) => {
          this.plugin.settings.sidebarOpen = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("数据").setHeading();

    const info = containerEl.createDiv({ cls: "pdfann-settings-info" });
    const count = Object.keys(this.plugin.data.files || {}).length;
    info.setText(
      `已记录 ${count} 个文件的批注。批注只存在插件自己的 data.json 里，不写进 PDF，也不在你的笔记库里新增文件。当前版本 ${this.plugin.manifest.version}。`
    );

    new Setting(containerEl)
      .setName("清除全部批注数据")
      .setDesc("只清除本插件保存的批注，不会动任何 PDF 或笔记文件。")
      .addButton((b) =>
        b
          .setButtonText("清除")
          .setWarning()
          .onClick(async () => {
            this.plugin.data.files = {};
            this.plugin.data.crops = {};
            await this.plugin.persist();
            new Notice("已清除");
            this.display();
          })
      );
  }
}
