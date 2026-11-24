# Changelog

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
