# Changelog

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
