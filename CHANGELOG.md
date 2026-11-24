# Changelog

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
