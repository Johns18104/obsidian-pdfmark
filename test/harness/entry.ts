import "./dom";
import { PDFView } from "../../src/view";
import { buildLayout } from "../../src/textlayer";
import { AnnotStore } from "../../src/store";
import { DEFAULT_SETTINGS } from "../../src/types";
import { PdfAnnotatorSettingTab } from "../../src/main";
import { resolveLang, setLanguage } from "../../src/i18n";
import { buildMarkdown } from "../../src/exporter";
import { burnAnnotations } from "../../src/burn";
import { TFile, WorkspaceLeaf } from "obsidian";

async function boot() {
  const q = new URLSearchParams(location.search);
  const name = q.get("file") || "sample.pdf";
  const res = await fetch(name);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const file: any = new TFile(name);
  const plugin: any = {
    data: { settings: { ...DEFAULT_SETTINGS }, files: {}, crops: {} },
    manifest: { version: "test" },
    assetUrl: () => "",
    persist: async () => {},
  };
  plugin.settings = plugin.data.settings;
  // Tests pin the language instead of guessing from navigator.language.
  plugin.settings.language = (q.get("lang") as any) || "zh";
  setLanguage(plugin.settings.language);
  plugin.store = new AnnotStore(plugin);

  const app: any = {
    vault: {
      getAbstractFileByPath: (p: string) => (p === file.path ? file : null),
      readBinary: async () => bytes.buffer,
      modifyBinary: async () => {},
      configDir: ".obsidian",
      adapter: {},
    },
    workspace: {
      getActiveFile: () => file,
      on: () => ({}),
      getLeaf: () => ({}),
      detachLeavesOfType() {},
      getActiveViewOfType: () => null,
    },
  };
  plugin.app = app;

  const leaf: any = new WorkspaceLeaf(app);
  const view: any = new PDFView(leaf, plugin);
  document.getElementById("mount")!.appendChild(view.containerEl);
  await view.onOpen();
  await view.openPath(file.path);

  (window as any).view = view;
  (window as any).__buildLayout = buildLayout;
  (window as any).store = plugin.store;
  (window as any).__burn = burnAnnotations;
  (window as any).__buildMarkdown = buildMarkdown;
  (window as any).__resolveLang = resolveLang;
  (window as any).setLang = (l: "zh" | "en" | "auto") => {
    plugin.settings.language = l;
    setLanguage(l);
    if (view && typeof view.refreshLanguage === "function") view.refreshLanguage();
    return plugin.settings.language;
  };
  (window as any).openSettings = () => {
    const tab: any = new PdfAnnotatorSettingTab(plugin);
    document.getElementById("mount")!.appendChild(tab.containerEl);
    tab.display();
    return tab;
  };
  (window as any).ready = true;
}

boot().catch((e) => {
  (window as any).bootError = String((e && e.stack) || e);
  console.error("[harness] boot failed", e);
});
