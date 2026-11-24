import { Annot, FileRecord, PRect, PluginData } from "./types";

/**
 * The slice of the plugin the store needs. Declared structurally instead of
 * importing the plugin class, so store.ts and main.ts do not import each other.
 */
export interface StoreHost {
  data: PluginData;
  persist(): Promise<void>;
}

/**
 * All annotation data lives inside the plugin's own data.json
 * ({ settings, files, crops }) so the vault itself is never touched.
 */
export class AnnotStore {
  private timer: number | null = null;

  constructor(private plugin: StoreHost) {}

  private get files(): Record<string, FileRecord> {
    return this.plugin.data.files;
  }

  private get crops(): Record<string, Record<string, PRect>> {
    return this.plugin.data.crops;
  }

  save() {
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.plugin.persist().catch((e: unknown) => console.error(e));
    }, 400);
  }

  async flush() {
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    await this.plugin.persist();
  }

  record(path: string): FileRecord {
    let r = this.files[path];
    if (!r) {
      r = { annots: [], lastPage: 1, scrollRatio: 0, updated: Date.now() };
      this.files[path] = r;
    }
    if (!r.annots) r.annots = [];
    return r;
  }

  get(path: string) {
    return this.record(path);
  }

  annotsOf(path: string, page?: number): Annot[] {
    const r = this.files[path];
    if (!r || !r.annots) return [];
    return typeof page === "number" ? r.annots.filter((a) => a.page === page) : r.annots;
  }

  countOf(path: string) {
    return this.annotsOf(path).length;
  }

  add(path: string, a: Annot) {
    const r = this.record(path);
    r.annots.push(a);
    r.updated = Date.now();
  }

  remove(path: string, id: string) {
    const r = this.record(path);
    r.annots = r.annots.filter((a) => a.id !== id);
    r.updated = Date.now();
  }

  find(path: string, id: string): Annot | null {
    const r = this.files[path];
    if (!r) return null;
    return r.annots.find((a) => a.id === id) || null;
  }

  replaceAnnots(path: string, annots: Annot[]) {
    const r = this.record(path);
    r.annots = annots;
    r.updated = Date.now();
  }

  touch(path: string, page: number, ratio: number) {
    const r = this.record(path);
    r.lastPage = page;
    r.scrollRatio = Math.max(0, Math.min(1, ratio));
    r.updated = Date.now();
  }

  cropOf(path: string, page: number): PRect | null {
    const m = this.crops[path];
    if (!m) return null;
    return m[String(page)] || null;
  }

  setCrop(path: string, page: number, rect: PRect | null) {
    if (!this.crops[path]) this.crops[path] = {};
    if (rect) this.crops[path][String(page)] = rect;
    else delete this.crops[path][String(page)];
  }

  hasCrops(path: string) {
    const m = this.crops[path];
    return !!m && Object.keys(m).length > 0;
  }

  clearCrops(path: string) {
    delete this.crops[path];
  }
}
