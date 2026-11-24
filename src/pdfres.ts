import { CMAP_DATA, FONT_DATA } from "./pdfres-b64";

/**
 * pdf.js normally fetches CMap tables (.bcmap) and standard font files from a
 * URL (cMapUrl / standardFontDataUrl). A community plugin cannot ship those
 * folders: Obsidian only downloads main.js, manifest.json and styles.css from
 * the GitHub release, so anything the reader needs at runtime has to be inside
 * the bundle.
 *
 * These two factories serve the same data straight from memory. The build
 * script (build.mjs) inlines pdfjs-dist/cmaps and pdfjs-dist/standard_fonts as
 * base64, so CJK documents keep their text layer after a store install.
 */

const byteCache = new Map<string, Uint8Array>();

function decode(base64: string, cacheKey: string): Uint8Array {
  const hit = byteCache.get(cacheKey);
  if (hit) return hit;
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  byteCache.set(cacheKey, out);
  return out;
}

/** CMapCompressionType.BINARY — the bundled .bcmap files are inflate-compressed. */
const BINARY = 1;

export class MemoryCMapReaderFactory {
  baseUrl: string | null;
  isCompressed: boolean;

  constructor(params: { baseUrl?: string | null; isCompressed?: boolean } = {}) {
    this.baseUrl = params.baseUrl ?? null;
    this.isCompressed = params.isCompressed ?? true;
  }

  async fetch({ name }: { name: string }) {
    if (!name) throw new Error("CMap name must be specified.");
    const data = (CMAP_DATA as Record<string, string>)[name];
    if (!data) throw new Error("Unable to load built-in CMap: " + name);
    return { cMapData: decode(data, "cmap:" + name), compressionType: BINARY };
  }
}

export class MemoryStandardFontDataFactory {
  baseUrl: string | null;

  constructor(params: { baseUrl?: string | null } = {}) {
    this.baseUrl = params.baseUrl ?? null;
  }

  async fetch({ filename }: { filename: string }) {
    if (!filename) throw new Error("Font filename must be specified.");
    const data = (FONT_DATA as Record<string, string>)[filename];
    if (!data) throw new Error("Unable to load built-in font data: " + filename);
    return decode(data, "font:" + filename);
  }
}

export function bundledResourceStats() {
  return {
    cmaps: Object.keys(CMAP_DATA).length,
    fonts: Object.keys(FONT_DATA).length,
  };
}
