// Coordinate mapping between the displayed canvas and the actual video frame.
// Handles object-fit: contain letterbox / pillarbox offsets so the mask we
// submit matches ACTUAL video frame pixels, not just the visible browser canvas.

export interface DisplayGeometry {
  // size of the element on screen (CSS px)
  displayW: number;
  displayH: number;
  // intrinsic video frame size
  frameW: number;
  frameH: number;
  // rendered content box inside the element (object-fit: contain)
  contentX: number;
  contentY: number;
  contentW: number;
  contentH: number;
  // scale from display content px -> frame px
  scale: number;
}

/**
 * Compute how a frameW x frameH video renders inside a displayW x displayH box
 * using object-fit: contain (preserves aspect ratio, adds letterbox/pillarbox).
 */
export function computeGeometry(
  displayW: number,
  displayH: number,
  frameW: number,
  frameH: number
): DisplayGeometry {
  const frameAR = frameW / frameH;
  const boxAR = displayW / displayH;
  let contentW: number, contentH: number;
  if (frameAR > boxAR) {
    // frame is wider -> pillarbox top/bottom (letterbox actually); width fills
    contentW = displayW;
    contentH = displayW / frameAR;
  } else {
    contentH = displayH;
    contentW = displayH * frameAR;
  }
  const contentX = (displayW - contentW) / 2;
  const contentY = (displayH - contentH) / 2;
  const scale = frameW / contentW; // display px -> frame px
  return { displayW, displayH, frameW, frameH, contentX, contentY, contentW, contentH, scale };
}

/** Map a point in display/CSS coordinates (relative to the canvas element) to frame coordinates. */
export function displayToFrame(g: DisplayGeometry, dx: number, dy: number): { x: number; y: number } | null {
  const cx = dx - g.contentX;
  const cy = dy - g.contentY;
  if (cx < 0 || cy < 0 || cx > g.contentW || cy > g.contentH) {
    // outside the actual video content (in the letterbox bars) -> clamp to edge
    const clampedX = Math.max(0, Math.min(g.contentW, cx));
    const clampedY = Math.max(0, Math.min(g.contentH, cy));
    return { x: clampedX * g.scale, y: clampedY * g.scale };
  }
  return { x: cx * g.scale, y: cy * g.scale };
}

/** Map a frame-space radius/brush size to display content px (for drawing the overlay). */
export function frameToDisplayRadius(g: DisplayGeometry, frameRadius: number): number {
  return frameRadius / g.scale;
}

/** Map a display brush radius to frame radius. */
export function displayToFrameRadius(g: DisplayGeometry, displayRadius: number): number {
  return displayRadius * g.scale;
}
