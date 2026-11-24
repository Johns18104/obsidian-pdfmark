/**
 * Tiny two-language layer: every user-visible string is written as
 * `t("中文", "English")`, so a translation sits next to the code that uses it.
 * The active language is chosen in the plugin settings; "auto" follows the
 * Obsidian UI language, then the browser.
 */

export type LangSetting = "auto" | "zh" | "en";
export type Lang = "zh" | "en";

let current: Lang = "zh";

function fromSystem(): Lang {
  // Obsidian writes the chosen UI language to localStorage; when it is missing
  // (fresh install, tests) fall back to the browser.
  try {
    const stored = window.localStorage.getItem("language");
    if (stored) return stored.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch (e) {}
  const nav = (typeof navigator !== "undefined" && navigator.language) || "en";
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function resolveLang(setting: LangSetting | undefined): Lang {
  if (setting === "zh" || setting === "en") return setting;
  return fromSystem();
}

export function setLanguage(setting: LangSetting | undefined): Lang {
  current = resolveLang(setting);
  return current;
}

export function currentLang(): Lang {
  return current;
}

export function isEnglish(): boolean {
  return current === "en";
}

/** Pick the string for the active language. */
export function t(zh: string, en: string): string {
  return current === "en" ? en : zh;
}

/** Same, with `{0}`, `{1}`… replaced by the extra arguments. */
export function tf(zh: string, en: string, ...args: Array<string | number>): string {
  return (current === "en" ? en : zh).replace(/\{(\d+)\}/g, (m, i) => {
    const v = args[Number(i)];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * Pair kept in a table that is built at module load, before the settings are
 * known — resolve it when it is actually rendered.
 */
export type Pair = [zh: string, en: string];

export function tp(pair: Pair): string {
  return current === "en" ? pair[1] : pair[0];
}
