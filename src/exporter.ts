import { TFile } from "obsidian";
import { Annot, InkAnnot, NoteAnnot, ShapeAnnot, TextMark } from "./types";
import { t, tf } from "./i18n";

/** Resolved at export time, not at module load, so the language setting applies. */
function typeLabel(type: string): string {
  const pairs: Record<string, [string, string]> = {
    highlight: ["高亮", "Highlight"],
    underline: ["下划线", "Underline"],
    strike: ["删除线", "Strikethrough"],
    ink: ["手写", "Ink"],
    line: ["直线", "Line"],
    rect: ["方框", "Box"],
    ellipse: ["椭圆", "Oval"],
    arrow: ["箭头", "Arrow"],
    note: ["便签", "Note"],
    textbox: ["文字", "Text"],
  };
  const p = pairs[type] || ["批注", "Annotation"];
  return t(p[0], p[1]);
}

function fmtDate(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function buildMarkdown(file: TFile, annots: Annot[], _title: string): string {
  const byPage = new Map<number, Annot[]>();
  for (const a of annots) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page)!.push(a);
  }
  const pages = Array.from(byPage.keys()).sort((a, b) => a - b);
  const link = (n: number) => `[[${file.name}#page=${n}|${tf("第 {0} 页", "page {0}", n)}]]`;

  const lines: string[] = [];
  lines.push("---");
  lines.push(`source: "${file.basename}"`);
  lines.push(`file: "[[${file.name}]]"`);
  lines.push(`pages: ${pages.length}`);
  lines.push(`annotations: ${annots.length}`);
  lines.push(`exported: ${fmtDate(Date.now())}`);
  lines.push(`tags: [${t("pdf批注", "pdf-annotations")}]`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${file.basename} · ${t("批注", "annotations")}`);
  lines.push("");

  for (const p of pages) {
    const list = byPage.get(p)!;
    lines.push(`## ${tf("第 {0} 页", "Page {0}", p)}`);
    lines.push("");
    for (const a of list) {
      if (a.type === "highlight" || a.type === "underline" || a.type === "strike") {
        const m = a as TextMark;
        const text = (m.text || "").trim();
        const body = text.replace(/\n/g, "\n> ");
        lines.push(`> ${body}`);
        lines.push(`> — ${typeLabel(a.type)} · ${link(p)}`);
        if (m.note) {
          lines.push("");
          lines.push(`**${t("批注", "Note")}**: ${m.note}`);
        }
        lines.push("");
      } else if (a.type === "note" || a.type === "textbox") {
        const n = a as any;
        const head = a.type === "note" ? typeLabel("note") : typeLabel("textbox");
        lines.push(`- **${head}**: ${(n.text || "").replace(/\n/g, " ")} · ${link(p)}`);
      } else if (a.type === "ink") {
        const ink = a as InkAnnot;
        const n = ink.strokes.reduce((s, st) => s + st.length, 0);
        lines.push(`- ${tf("手写笔迹（{0} 笔 / {1} 点）", "Ink ({0} strokes / {1} points)", ink.strokes.length, n)} · ${link(p)}`);
      } else {
        const s = a as ShapeAnnot;
        lines.push(`- ${tf("{0}标注", "{0} shape", typeLabel(a.type))} · ${link(p)}`);
      }
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    tf("共 {0} 条批注，覆盖 {1} 页。", "{0} annotations across {1} pages.", annots.length, pages.length)
  );
  return lines.join("\n");
}
