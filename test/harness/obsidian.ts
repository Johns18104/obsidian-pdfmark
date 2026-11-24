/** Minimal stand-in for the Obsidian runtime, used only by the local browser harness. */

export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  constructor(path: string) {
    this.path = path;
    const parts = path.split("/");
    this.name = parts[parts.length - 1];
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }
}

export class App {}

export class WorkspaceLeaf {
  app: any;
  constructor(app: any) {
    this.app = app;
  }
  async setViewState() {}
}

export class ItemView {
  app: any;
  leaf: any;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(leaf: any) {
    this.leaf = leaf;
    this.app = leaf && leaf.app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf-content";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "view-content";
    this.containerEl.appendChild(this.contentEl);
  }
  registerDomEvent(el: any, type: string, cb: any, opts?: any) {
    el.addEventListener(type, cb, opts);
  }
  registerEvent() {}
  registerInterval() {}
  addAction() {}
  getState() {
    return {};
  }
  async setState(_s: any, _r: any) {}
  getViewType() {
    return "";
  }
  getDisplayText() {
    return "";
  }
  getIcon() {
    return "";
  }
}

export function setIcon(el: HTMLElement, name: string) {
  el.setAttribute("data-icon", name);
}

export class Notice {
  constructor(msg: string) {
    console.log("[notice]", msg);
  }
}

export class Menu {
  addItem(cb: any) {
    const item: any = {
      setTitle: () => item,
      setIcon: () => item,
      onClick: () => item,
    };
    cb(item);
    return this;
  }
  addSeparator() {
    return this;
  }
  showAtMouseEvent() {}
}

export class Modal {
  app: any;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(app: any) {
    this.app = app;
    this.containerEl = document.createElement("div");
    this.contentEl = document.createElement("div");
    this.containerEl.appendChild(this.contentEl);
  }
  open() {
    document.body.appendChild(this.containerEl);
    (this as any).onOpen && (this as any).onOpen();
  }
  close() {
    this.containerEl.remove();
  }
}

export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export function normalizePath(p: string) {
  return p;
}
