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

/** Minimal settings UI so the real settings tab can be rendered in tests. */
export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl: HTMLElement;
  constructor(app?: any, plugin?: any) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "vertical-tab-content";
  }
}

export class Setting {
  settingEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.settingEl = document.createElement("div");
    this.settingEl.className = "setting-item";
    this.nameEl = document.createElement("div");
    this.nameEl.className = "setting-item-name";
    this.descEl = document.createElement("div");
    this.descEl.className = "setting-item-description";
    this.controlEl = document.createElement("div");
    this.controlEl.className = "setting-item-control";
    this.settingEl.append(this.nameEl, this.descEl, this.controlEl);
    containerEl.appendChild(this.settingEl);
  }
  setName(v: string) {
    this.nameEl.textContent = v;
    return this;
  }
  setDesc(v: string) {
    this.descEl.textContent = v;
    return this;
  }
  setHeading() {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  addToggle(cb: (t: any) => void) {
    const input = document.createElement("input");
    input.type = "checkbox";
    let value = false;
    const handlers: Array<(v: boolean) => void> = [];
    const toggle = {
      setValue(v: boolean) {
        value = v;
        input.checked = v;
        return toggle;
      },
      onChange(fn: (v: boolean) => void) {
        handlers.push(fn);
        return toggle;
      },
      getValue: () => value,
    };
    input.addEventListener("change", () => {
      value = input.checked;
      handlers.forEach((fn) => fn(value));
    });
    this.controlEl.appendChild(input);
    cb(toggle);
    return this;
  }
  addDropdown(cb: (d: any) => void) {
    const sel = document.createElement("select");
    const handlers: Array<(v: string) => void> = [];
    const dd = {
      addOption(value: string, label: string) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        sel.appendChild(o);
        return dd;
      },
      addOptions(map: Record<string, string>) {
        for (const [v, l] of Object.entries(map)) dd.addOption(v, l);
        return dd;
      },
      setValue(v: string) {
        sel.value = v;
        return dd;
      },
      getValue: () => sel.value,
      onChange(fn: (v: string) => void) {
        handlers.push(fn);
        return dd;
      },
    };
    sel.addEventListener("change", () => handlers.forEach((fn) => fn(sel.value)));
    this.controlEl.appendChild(sel);
    cb(dd);
    return this;
  }
  addButton(cb: (b: any) => void) {
    const el = document.createElement("button");
    let onClick: (() => void) | null = null;
    const btn = {
      setButtonText(t: string) {
        el.textContent = t;
        return btn;
      },
      setWarning() {
        el.classList.add("mod-warning");
        return btn;
      },
      setCta() {
        return btn;
      },
      onClick(fn: () => void) {
        onClick = fn;
        return btn;
      },
    };
    el.addEventListener("click", () => onClick && onClick());
    this.controlEl.appendChild(el);
    cb(btn);
    return this;
  }
}
export function normalizePath(p: string) {
  return p;
}
