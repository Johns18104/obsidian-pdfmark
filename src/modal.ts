import { App, Modal } from "obsidian";
import { t } from "./i18n";

export class TextInputModal extends Modal {
  private done = false;
  constructor(
    app: App,
    private heading: string,
    private initial: string,
    private resolveFn: (v: string | null) => void
  ) {
    super(app);
  }

  static open(app: App, heading: string, initial: string): Promise<string | null> {
    return new Promise((resolve) => {
      new TextInputModal(app, heading, initial, resolve).open();
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("pdfann-modal");
    contentEl.createEl("h4", { text: this.heading });
    const ta = contentEl.createEl("textarea", { cls: "pdfann-modal-input" });
    ta.value = this.initial;
    const row = contentEl.createDiv("pdfann-modal-row");
    const cancel = row.createEl("button", { text: t("取消", "Cancel") });
    const ok = row.createEl("button", { text: t("确定", "OK"), cls: "mod-cta" });
    cancel.onclick = () => this.close();
    ok.onclick = () => {
      this.done = true;
      this.resolveFn(ta.value);
      this.close();
    };
    ta.onkeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        ok.click();
      }
    };
    window.setTimeout(() => ta.focus(), 40);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) {
      this.done = true;
      this.resolveFn(null);
    }
  }
}

export class ConfirmModal extends Modal {
  private done = false;
  constructor(
    app: App,
    private heading: string,
    private detail: string,
    private resolveFn: (v: boolean) => void
  ) {
    super(app);
  }

  static open(app: App, heading: string, detail: string): Promise<boolean> {
    return new Promise((resolve) => {
      new ConfirmModal(app, heading, detail, resolve).open();
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("pdfann-modal");
    contentEl.createEl("h4", { text: this.heading });
    if (this.detail) contentEl.createEl("p", { text: this.detail, cls: "pdfann-modal-desc" });
    const row = contentEl.createDiv("pdfann-modal-row");
    const cancel = row.createEl("button", { text: t("取消", "Cancel") });
    const ok = row.createEl("button", { text: t("确定", "OK"), cls: "mod-cta" });
    cancel.onclick = () => this.close();
    ok.onclick = () => {
      this.done = true;
      this.resolveFn(true);
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) {
      this.done = true;
      this.resolveFn(false);
    }
  }
}
