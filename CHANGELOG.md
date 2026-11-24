# Changelog

## 1.1.8 — “take over .pdf” now works, plus the type warnings

**The take-over setting had never worked.** It relied on
`registerExtensions(["pdf"], …)`, but Obsidian's own PDF reader is registered
for that extension first and `ViewRegistry.registerExtensions()` throws rather
than overwrite it — the throw was caught by a `try/catch` and logged, so the
toggle looked enabled while every PDF still opened in the built-in viewer
(with no tool rail, which is how this surfaced). The extension route is
impossible by design; PDFmark now waits for a PDF to open in the built-in
viewer and swaps that leaf to its own view. Restored tabs from a previous
session never emit `file-open`, so the layout-ready pass covers those, and
turning the setting on converts PDFs that are already open. No restart needed
any more.

The 1.1.6 notes said the ~300 `any` warnings "come from Obsidian's loosely typed
API surface". That was wrong, and worth correcting: most of them started at
**our own** `any` annotations — `plugin: any`, `pdfDoc: any`, `viewport: any`,
`files: Record<string, any>` — and every read through one of those turned into
another warning downstream. Fifteen seeds, three hundred findings.

They are all gone now; the source lints at **2 warnings and 0 errors**.

- **The plugin instance has a type.** `PDFView` and `AnnotStore` take a small
  structural `ViewHost` / `StoreHost` interface instead of `any`, so
  `this.plugin.settings` and `this.store.annotsOf(...)` are checked. Declared
  structurally on purpose: `view.ts` still does not import `main.ts`.
- **pdf.js objects are typed**, using the declarations the package already
  ships: `PDFDocumentProxy`, `PDFPageProxy`, `PageViewport`, `RenderTask`,
  `RefProxy`, `DocumentInitParameters`. Coordinate conversion needs no `any`
  any more: `PageViewport.convertToViewportPoint()` returns `any[]`, so one
  `toPt()` helper takes the pair and returns a plain `{x, y}`.
- **`data.json` has a shape.** `PluginData` (`types.ts`) is now the single
  definition of `{ settings, files, crops }`, shared by the plugin, the store
  and the settings tab; `loadData()` is read once through
  `Partial<PluginData>`. The outline cache and drag geometry got named types
  too (`OutlineNode`, `Geom`), which replaced eight `(a as any)` casts with
  ordinary `in` narrowing.
- **`catch (e)` is `unknown`**, formatted by one `errText()` helper, and
  `errText` reads `message` only when it is really there.
- **No more `as any` on the Obsidian API:** the vault adapters that carry
  `getResourcePath` are described by an intersection type, and
  `applyLanguage()` uses `instanceof PDFView` instead of poking at
  `leaf.view.refreshLanguage`.
- **A real bug fell out of it:** `burn()` used to hand `modifyBinary()` a
  `Uint8Array` behind an `as any`; it now passes an exact-length `ArrayBuffer`.
  Same bytes, but the call matches the documented signature.
- **The text measurer** uses `createEl("canvas")` instead of
  `document.createElement`, the last remaining place that reached for the
  global document.
- **Behaviour is unchanged.** These are type annotations only, and the bundle
  is built by esbuild, which does not type-check — the emitted `main.js` draws
  the same pixels and writes the same PDF. All 46 browser assertions still
  pass.
- **So it stays checked:** `npm run typecheck` (`tsc --noEmit`) is now a
  script, and the source compiles with zero errors. The take-over swap moved
  into `takeover.ts` so it could get a regression test of its own — the suite
  is 47 assertions now.
- **Still open, on purpose:** the last two warnings are `setWarning()` (use
  `setDestructive()`) and the declarative settings API — both need Obsidian
  **1.13.0**. Adopting them would raise `minAppVersion` and lock out everyone
  on 1.8.7–1.12, so they stay until 1.13 is the common version.

## 1.1.6 — the API-version error, and the linter that should have caught it

1.1.5 traded one warning for a new **error**: it started calling `getLanguage()`,
which only exists from Obsidian 1.8.7, while `minAppVersion` still said 1.5.0.
The directory rejects a plugin that uses APIs newer than the version it declares.

- **`minAppVersion` is now 1.8.7**, the version that actually contains
  `getLanguage()`. `versions.json` records the change, so anyone below 1.8.7 is
  offered 1.1.4 instead of a build that cannot run.
- **The same checks now run locally.** `npm run lint` uses
  `eslint-plugin-obsidianmd` — the exact rule set behind the directory review —
  with `minAppVersion` fed in, so an unsupported API shows up before publishing
  rather than after.
- **Warnings cleared along the way:**
  - `document.createElement` → `createEl` / `createDiv` / `createSvg`, and
    `document` → `activeDocument`, so the plugin also behaves inside popout
    windows (all four helpers exist since 0.15.0 or earlier).
  - `requestAnimationFrame` → `window.requestAnimationFrame`.
  - 42 floating promises are now explicitly marked `void`, which is what they
    always were: fire-and-forget follow-up work.
  - Dead variables and an unused import removed; the punctuation character class
    writes `[` and `]` as `\u005b\u005d` (the linter's suggestion to drop the
    backslash would have ended the class early and changed the expression).
  - `activeLeaf` → `getActiveViewOfType(ItemView)`, which is not deprecated and
    answers the same question.
- **Stylesheet:** the single `!important` is gone — `.pdfann-root` is repeated
  in the selector so it out-specifies Obsidian's own `.view-content` padding.
- **Lockfile:** `tar` is pinned to a patched 7.x through `overrides`; it only
  reached the tree as an optional dependency of pdf.js's Node canvas build.
  The remaining advisory on pdf.js 3.11 (CVE-2024-4367) does not apply to this
  bundle, see the README note: `new Function` and `eval` are stripped at build
  time, so the font path never compiles code.
- **Still open, on purpose:** `ButtonComponent.setWarning()` is deprecated in
  favour of `setDestructive()`, but that one needs Obsidian 1.13.0, so using it
  now would recreate the same error. The `any`-family warnings (about 300) come
  from Obsidian's loosely typed API surface and are warnings, not errors.

## 1.1.5 — clears the remaining review error

The 1.1.4 scan still reported one **error** and a handful of warnings. All of them
are addressed here; nothing a user sees has changed.

- **Error — "Don't detach leaves in onunload".** The plugin called
  `detachLeavesOfType()` while shutting down, which resets a PDF leaf to its
  default location even after the user deliberately moved it. Obsidian already
  tears the view down on disable, so the call was removed.
- **Warning — `localStorage` for the UI language.** "Follow system" now asks
  Obsidian itself via `getLanguage()`, so the plugin no longer touches web
  storage at all and matches the app language exactly (including `zh-TW`).
- **Warning — unnecessary type assertions (48 `as` casts and 16 `!`).** The
  project compiles without `strictNullChecks`, where those assertions changed
  nothing; the discriminator on `annot.type` already narrows every annotation.
  Removed, and the imports that only existed for them were dropped.
- **Warning — empty block statements (23).** Bare `catch {}` blocks became
  `catch { /* ignore */ }`, which is what they always meant.

Still open on purpose: the clipboard is written to when you press copy or quote
and never read; and the `any`-related warnings that come from Obsidian's own
loosely typed API surface.

## 1.1.4 — installable from the community directory

The directory's automated review returned one **error** and three recommendations.
The error came from code bundled out of pdf.js rather than from PDFmark's own
source, but an error blocks installation from inside Obsidian, so it had to go.

- **Removed three dynamic-code paths that pdf.js ships.** `loadScript()` appended a
  `<script>` tag to fetch a worker or CMap table from a URL, `isEvalSupported()`
  probed `new Function("")`, and the Node branch called `eval("require")`. PDFmark
  inlines the worker, the CMap tables and the standard fonts and hands them to
  pdf.js as in-memory data, so none of the three could ever run. `build.mjs` now
  rewrites them out of the bundle, and the build fails loudly if a future
  pdfjs-dist upgrade moves them somewhere else.
- Glyph outlines are compiled by pdf.js's own interpreter instead of `new Function`.
  Identical output; the interpreter is pdf.js's documented fallback.
- No visible change on screen or in the burned PDF. The 46-assertion suite passes,
  and the Chinese text-layer probe still resolves 89 CJK characters from a CMap-only
  PDF with no external request.
- Two review recommendations are left as they are on purpose: the clipboard is only
  written to when you press copy or quote (never read), and `localStorage` is read
  once to detect the Obsidian interface language, not to store anything.

## 1.1.3 — the note dialog is no longer covered, and one click makes one note

- **Fixed: the 确定/取消 buttons of the 批注 dialog were hidden behind the floating text menu.** That menu was pinned at `z-index: 1000`, above Obsidian's modal layer, so it painted over the dialog. It now closes the moment you pick 批注 (nothing you picked is lost — the rects, text and colour are already captured), and its `z-index` moved to `var(--layer-popover)`, below dialogs in general.
- **Fixed: clicking 批注 again while the dialog was open created extra notes.** Each click started another dialog and each confirm added another highlight-with-note on the same text. The button is now guarded by a single-flight flag, and the popup is gone after the first click so there is nothing left to click twice.
- An empty or whitespace-only note now behaves like cancelling instead of creating an invisible highlight.
- Regression suite: 46 assertions, including "the menu is gone, exactly one dialog with its buttons exists, and two rapid clicks produce one annotation".

## 1.1.2 — thicker underline and strikethrough

- Underline and strikethrough rules are now **2.5 pt** (they were ~1.3 pt on screen and ~1.2 pt once burned in, which read as a hairline next to 12 pt text). The value lives in one constant, `TEXT_RULE_WIDTH`, so the screen and the burned PDF can no longer drift apart.
- The underline now rides the bottom edge of the text box instead of a pixel offset that did not match the burned output; the strikethrough stays through the middle.
- Both rules use a butt cap, so a long rule no longer grows a rounded tip at either end.
- Regression suite: 44 assertions, including the measured rule width (2.5 × zoom on screen, 2.5 pt in the burned PDF) and its anchor point.

## 1.1.1 — arrow heads that survive zooming

- **Fixed: the arrow looked broken once zoomed in.** The shaft was drawn all the way to the tip with a round cap, so the cap stuck out in front of the point — barely visible at 100%, an obvious rounded nub at 300%. The shaft now stops inside the base of the head and uses a flat cap, and the head is a filled triangle whose size comes from the stroke width in PDF units, so it scales with the page instead of being pinned to a pixel value. Screen rendering and the burned-in PDF share one geometry function (`src/arrow.ts`), so what you see is what gets written.
- **Shape stroke width now stops at 13 pt** (was 30). Straight lines, boxes, ellipses and arrows no longer look like paint rollers; the pen and the highlighter keep their 0.5–30 range because a wide highlighter stroke is normal.
- **Font size for text boxes and notes now stops at 30 pt** (was 48); the minimum is unchanged at 6 pt.
- Values already stored above the new limits are not rewritten — they only snap to the range the next time you move the slider.
- Regression suite: 43 assertions, including the slider range per tool, the shaft/head geometry at two stroke widths, and the burned arrow carrying its own head.

## 1.1.0 — English interface, language switch

- The entire interface can now be shown in English: tool rail, options bar, menus, dialogs, sidebar, empty states, notices, settings page and exported Markdown.
- **Settings → PDFmark → Language → Interface language** offers *Follow system* (default), *中文* and *English*. *Follow system* uses the Obsidian UI language, then the system locale.
- Switching is applied live to the settings page and to open PDFs (`refreshLanguage()` rebuilds the rail, bar, options and sidebar without losing the page). Command palette entries and the ribbon tooltip are registered at load, so they change after a restart.
- Translated strings live next to the code as `t("中文", "English")`, with `tf()` for interpolation; the tool table keeps both labels so nothing is frozen at module load.
- Exported Markdown, its YAML tags (`pdf-annotations`) and page links follow the active language.
- Settings row order: Language first, then how PDFs open, reading, data.
- Regression suite: 38 assertions, including English rail labels, an English settings page and an English export.

## 1.0.3 — ink: keep drawing or grab the stroke?

Set by a new switch, **Drag ink when the pen presses on it**, in the plugin settings.

- **Off (default)** — with the pen or highlighter armed, pressing within 4 pt of an existing stroke starts a new stroke, so you can keep writing across an old line. This is what 1.0.0 did.
- **On** — the same press grabs the whole stroke and drags it, adding nothing.
- **Select** always drags ink, whatever the switch says, and the eraser is unaffected.
- Regression suite: 33 assertions, now covering both positions of the switch.

## 1.0.2 — the font-size slider actually changes the text

- Fixed: with the **Text box** tool the bottom slider was labelled 字号 but wrote the *stroke width* of shapes, so text size never changed. It now stores the text size, on the tool default and on a selected card.
- Fixed: selecting a text box or a note and dragging the slider did nothing, because the code looked for a `width` field that those annotations do not have.
- Notes had the same defect and no size setting at all. Notes now carry their own font size, default 11 pt, adjustable 6–48 pt, and burning respects it.
- The slider scale follows the tool: 6–48 pt in steps of 1 for text and notes, 0.5–30 in steps of 0.5 for pens and shapes.
- A selection is edited on its own: dragging the slider with a card selected no longer overwrites the default size used for the next one.
- Notes used to draw their body in the pin colour, so a yellow note had pale yellow text. The body is now always dark; the colour stays on the pin and spine.
- One slider drag is a single undo step.
- Regression suite: 32 assertions, including "the slider changes the font size, not the line width" for text, notes and the pen.

## 1.0.1 — dragging without switching tools

- Any annotation can now be moved while its own tool is still active: a note with the note tool, a text box with the text box tool, a box with the box tool, a pen stroke with the pen. Previously the drag cursor appeared but the press fell through and nothing moved.
- Rectangle and ellipse only grab near their outline when a drawing tool is armed, so a new shape can still be drawn inside an existing one.
- Ink can be moved in Select mode too; the whole stroke travels as one piece.
- Dragging no longer creates a duplicate annotation on top of the one you grabbed, and each drag is a single undo step.
- The cursor is a four-way arrow wherever a drag will actually work, and a crosshair under the eraser.
- Renamed the first tool from 选字 to 选中.
- Regression suite: 27 assertions, including grab-and-drag for every tool.

## 1.0.0 — first public release

Initial release for the Obsidian community directory.

- Text marks on any selection: highlight, underline, strikethrough, 7 colours, partial-line and multi-line selections.
- Freehand pen and highlighter with adjustable width and colour.
- Line, rectangle, ellipse and arrow shapes; drag to create, drag to move, resize from handles.
- Sticky notes and free text boxes; both are rendered on the page as real text, in Chinese and English.
- Eraser, undo / redo (50 steps), reading-position memory, page-number jump, PDF outline, annotation sidebar.
- Export annotations to a Markdown note with quotes and `#page=` links.
- Burn annotations into the PDF itself (original backed up first). Notes and text boxes are drawn as readable text, never as a bare icon.
- Night inversion, crop white margins, fit-width zoom.
- Works offline. No network requests, no telemetry, no accounts, no ads.
- pdf.js (Apache-2.0), its CMap tables and standard fonts, and pdf-lib (MIT) are bundled into `main.js` so a store install needs no extra files.

## 0.1.x — internal builds

Development builds used for local testing on macOS, Windows, iPad and iPhone. Not released.
