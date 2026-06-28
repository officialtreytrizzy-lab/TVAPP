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

const EPSILON = 0.0001;

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
  const safeDisplayW = Math.max(1, displayW || 1);
  const safeDisplayH = Math.max(1, displayH || 1);
  const safeFrameW = Math.max(1, frameW || 1);
  const safeFrameH = Math.max(1, frameH || 1);

  const frameAR = safeFrameW / safeFrameH;
  const boxAR = safeDisplayW / safeDisplayH;
  let contentW: number;
  let contentH: number;

  if (frameAR > boxAR) {
    // Video is wider than the visible box: width fills, top/bottom letterbox.
    contentW = safeDisplayW;
    contentH = safeDisplayW / frameAR;
  } else {
    // Video is taller than the visible box: height fills, left/right pillarbox.
    contentH = safeDisplayH;
    contentW = safeDisplayH * frameAR;
  }

  const contentX = (safeDisplayW - contentW) / 2;
  const contentY = (safeDisplayH - contentH) / 2;
  const scale = safeFrameW / Math.max(EPSILON, contentW);

  return {
    displayW: safeDisplayW,
    displayH: safeDisplayH,
    frameW: safeFrameW,
    frameH: safeFrameH,
    contentX,
    contentY,
    contentW,
    contentH,
    scale,
  };
}

/** Map a point in display/CSS coordinates (relative to the canvas element) to frame coordinates. */
export function displayToFrame(g: DisplayGeometry, dx: number, dy: number): { x: number; y: number } | null {
  const cx = dx - g.contentX;
  const cy = dy - g.contentY;

  // Do not clamp touches from letterbox/pillarbox bars into the video. Clamping
  // made edge taps create masks in the wrong frame location.
  if (cx < 0 || cy < 0 || cx > g.contentW || cy > g.contentH) return null;

  return {
    x: Math.max(0, Math.min(g.frameW - 1, cx * g.scale)),
    y: Math.max(0, Math.min(g.frameH - 1, cy * g.scale)),
  };
}

/** Map a frame-space point to display/CSS coordinates for overlay debugging or previews. */
export function frameToDisplay(g: DisplayGeometry, fx: number, fy: number): { x: number; y: number } {
  return {
    x: g.contentX + fx / g.scale,
    y: g.contentY + fy / g.scale,
  };
}

/** Map a frame-space radius/brush size to display content px. */
export function frameToDisplayRadius(g: DisplayGeometry, frameRadius: number): number {
  return frameRadius / g.scale;
}

/** Map a display brush radius to frame radius. */
export function displayToFrameRadius(g: DisplayGeometry, displayRadius: number): number {
  return Math.max(0.5, displayRadius * g.scale);
}
