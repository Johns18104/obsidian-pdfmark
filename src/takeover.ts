/**
 * Taking over .pdf.
 *
 * Obsidian's own PDF reader is registered for the "pdf" extension under the
 * view type "pdf", and ViewRegistry.registerExtensions() throws instead of
 * overwriting an extension that is already claimed. So a plugin cannot map
 * .pdf to its own view; the only way in is to wait until the built-in viewer
 * has a leaf, then swap that leaf's view for ours.
 *
 * The swap is deliberately tiny and pure so it can be tested without a real
 * workspace: give it something that can list leaves, and it moves them.
 */

/** View type of Obsidian's built-in PDF viewer. */
export const NATIVE_PDF_VIEW = "pdf";

/** The two leaf methods the swap needs; a fake object can satisfy this. */
export interface SwitchableLeaf {
  getViewState(): { state?: unknown };
  setViewState(viewState: { type: string; state: { file: string } }): Promise<void>;
}

/** The only workspace method the swap needs. */
export interface LeafHost {
  getLeavesOfType(type: string): SwitchableLeaf[];
}

/**
 * Move every built-in PDF leaf to `viewType` (all of them, or only the leaf
 * showing `onlyPath`). Returns the paths it moved, which the tests assert on.
 * Leaves without a file in their state are left alone: there is nothing to
 * reopen them with.
 */
export function adoptNativePdfLeaves(host: LeafHost, viewType: string, onlyPath?: string): string[] {
  const moved: string[] = [];
  for (const leaf of host.getLeavesOfType(NATIVE_PDF_VIEW)) {
    const state = leaf.getViewState().state as { file?: string } | undefined;
    const path = state?.file;
    if (!path || (onlyPath && path !== onlyPath)) continue;
    moved.push(path);
    void leaf.setViewState({ type: viewType, state: { file: path } }).catch((e: unknown) => {
      console.warn("[pdfmark] could not take over", path, e);
    });
  }
  return moved;
}
