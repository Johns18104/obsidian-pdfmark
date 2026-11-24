import type { Pt } from "./types";

export interface ArrowGeom {
  /** The tip of the head, i.e. the second endpoint of the annotation. */
  tip: Pt;
  /**
   * Where the shaft has to stop. Stopping at the base of the head (instead of
   * running to the tip) is what keeps a thick round cap from poking out in
   * front of the point.
   */
  shaftEnd: Pt;
  /** The two base corners of the filled triangular head. */
  baseL: Pt;
  baseR: Pt;
  /** Head length along the shaft, in the same unit as the endpoints. */
  len: number;
}

/** Head length relative to the stroke width; same look at any zoom level. */
const HEAD_RATIO = 3.8;
/** Half of the base width relative to the head length. */
const BASE_RATIO = 0.42;

/**
 * Geometry for the arrow head. Screen rendering and the burned-in PDF both use
 * this, so what you see while editing is what ends up in the file.
 *
 * The head is sized from the stroke width in the annotation's own units, which
 * means it scales with the PDF zoom exactly like the line does — previously the
 * head had a pixel floor, so at high zoom the shaft (drawn to the very tip with
 * a round cap) grew through the head and the arrow looked broken.
 */
export function arrowHead(p0: Pt, p1: Pt, width: number): ArrowGeom {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;

  // Never let the head swallow the whole shaft: a 3 pt long arrow made with a
  // 13 pt brush would otherwise be all head and no line.
  const len = Math.min(Math.max(width, 0.6) * HEAD_RATIO, dist * 0.9);
  const half = len * BASE_RATIO;

  const bx = p1.x - ux * len;
  const by = p1.y - uy * len;
  return {
    tip: { x: p1.x, y: p1.y },
    // Slightly inside the base so there is no hairline gap between shaft and head.
    shaftEnd: { x: p1.x - ux * len * 0.8, y: p1.y - uy * len * 0.8 },
    baseL: { x: bx - uy * half, y: by + ux * half },
    baseR: { x: bx + uy * half, y: by - ux * half },
    len,
  };
}
