import { TFile } from "obsidian";
import { Annot, InkAnnot, NoteAnnot, ShapeAnnot, TextMark } from "./types";

const TYPE_LABEL: Record<string, string> = {
  highlight: "高亮",
  underline: "下划线",
  strike: "删除线",
  ink: "手写",
  line: "直线",
  rect: "方框",
  ellipse: "椭圆",
  arrow: "箭头",
  note: "便签",
  textbox: "文字",
};

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
  const link = (n: number) => `[[${file.name}#page=${n}|第 ${n} 页]]`;

  const lines: string[] = [];
  lines.push("---");
  lines.push(`source: "${file.basename}"`);
  lines.push(`file: "[[${file.name}]]"`);
  lines.push(`pages: ${pages.length}`);
  lines.push(`annotations: ${annots.length}`);
  lines.push(`exported: ${fmtDate(Date.now())}`);
  lines.push("tags: [pdf批注]");
  lines.push("---");
  lines.push("");
  lines.push(`# ${file.basename} · 批注`);
  lines.push("");

  for (const p of pages) {
    const list = byPage.get(p)!;
    lines.push(`## 第 ${p} 页`);
    lines.push("");
    for (const a of list) {
      if (a.type === "highlight" || a.type === "underline" || a.type === "strike") {
        const m = a as TextMark;
        const text = (m.text || "").trim();
        const body = text.replace(/\n/g, "\n> ");
        lines.push(`> ${body}`);
        lines.push(`> — ${TYPE_LABEL[a.type]} · ${link(p)}`);
        if (m.note) {
          lines.push("");
          lines.push(`**批注**：${m.note}`);
        }
        lines.push("");
      } else if (a.type === "note" || a.type === "textbox") {
        const n = a as any;
        const head = a.type === "note" ? "便签" : "文字";
        lines.push(`- **${head}**：${(n.text || "").replace(/\n/g, " ")} · ${link(p)}`);
      } else if (a.type === "ink") {
        const ink = a as InkAnnot;
        const n = ink.strokes.reduce((s, st) => s + st.length, 0);
        lines.push(`- 手写笔迹（${ink.strokes.length} 笔 / ${n} 点） · ${link(p)}`);
      } else {
        const s = a as ShapeAnnot;
        lines.push(`- ${TYPE_LABEL[a.type]}标注 · ${link(p)}`);
      }
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(`共 ${annots.length} 条批注，覆盖 ${pages.length} 页。`);
  return lines.join("\n");
}
