import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { computeGeometry, displayToFrame, displayToFrameRadius, type DisplayGeometry } from '@/lib/eraser/coords';

export interface MaskCanvasHandle {
  getMaskCanvas: () => HTMLCanvasElement | null;
  clear: () => void;
  undo: () => void;
  redo: () => void;
  hasMask: () => boolean;
  loadFromCanvas: (src: HTMLCanvasElement) => void;
}

interface Props {
  frameW: number;
  frameH: number;
  videoEl: HTMLVideoElement | null;
  brushSize: number; // display px
  erasing: boolean;
  maskVisible: boolean;
  onStrokeEnd?: () => void;
  disabled?: boolean;
}

const MAX_HISTORY = 25;

const MaskCanvas = forwardRef<MaskCanvasHandle, Props>(function MaskCanvas(
  { frameW, frameH, videoEl, brushSize, erasing, maskVisible, onStrokeEnd, disabled },
  ref
) {
  const overlayRef = useRef<HTMLCanvasElement | null>(null); // visible overlay
  const maskRef = useRef<HTMLCanvasElement | null>(null); // offscreen @ frame res
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const geomRef = useRef<DisplayGeometry | null>(null);
  const drawingRef = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const historyRef = useRef<ImageData[]>([]);
  const redoRef = useRef<ImageData[]>([]);
  const [, force] = useState(0);

  // init offscreen mask canvas at intrinsic frame resolution
  useEffect(() => {
    if (!maskRef.current) {
      const c = document.createElement('canvas');
      maskRef.current = c;
    }
    maskRef.current!.width = frameW;
    maskRef.current!.height = frameH;
    historyRef.current = [];
    redoRef.current = [];
    renderOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameW, frameH]);

  const recomputeGeometry = useCallback(() => {
    const wrap = wrapRef.current;
    const overlay = overlayRef.current;
    if (!wrap || !overlay) return;

    const rect = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    overlay.width = Math.round(rect.width * dpr);
    overlay.height = Math.round(rect.height * dpr);
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    geomRef.current = computeGeometry(rect.width, rect.height, frameW, frameH);
    renderOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameW, frameH]);

  useEffect(() => {
    recomputeGeometry();
    const onResize = () => recomputeGeometry();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    const ro = new ResizeObserver(() => recomputeGeometry());
    if (wrapRef.current) ro.observe(wrapRef.current);
    if (videoEl) ro.observe(videoEl);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      ro.disconnect();
    };
  }, [recomputeGeometry, videoEl]);

  // re-render overlay when visibility toggles
  useEffect(() => { renderOverlay(); /* eslint-disable-next-line */ }, [maskVisible]);

  function renderOverlay() {
    const overlay = overlayRef.current;
    const mask = maskRef.current;
    const g = geomRef.current;
    if (!overlay || !mask || !g) return;

    const ctx = overlay.getContext('2d')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.displayW, g.displayH);
    if (!maskVisible) return;

    // tint mask red and draw only into the actual rendered video content box
    const tint = document.createElement('canvas');
    tint.width = mask.width;
    tint.height = mask.height;
    const tctx = tint.getContext('2d')!;
    tctx.drawImage(mask, 0, 0);
    const id = tctx.getImageData(0, 0, mask.width, mask.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 10) {
        d[i] = 239;
        d[i + 1] = 68;
        d[i + 2] = 68;
        d[i + 3] = 150;
      }
    }
    tctx.putImageData(id, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tint, g.contentX, g.contentY, g.contentW, g.contentH);
  }

  function pushHistory() {
    const mask = maskRef.current;
    if (!mask) return;
    const ctx = mask.getContext('2d', { willReadFrequently: true })!;
    historyRef.current.push(ctx.getImageData(0, 0, mask.width, mask.height));
    if (historyRef.current.length > MAX_HISTORY) historyRef.current.shift();
    redoRef.current = [];
    force((n) => n + 1);
  }

  function getLocalPoint(e: PointerEvent | { clientX: number; clientY: number }) {
    const overlay = overlayRef.current!;
    const rect = overlay.getBoundingClientRect();
    return { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
  }

  function paintAt(fx: number, fy: number, fromX: number | null, fromY: number | null) {
    const mask = maskRef.current!;
    const g = geomRef.current!;
    const ctx = mask.getContext('2d')!;
    const frameRadius = displayToFrameRadius(g, brushSize / 2);
    ctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.lineWidth = frameRadius * 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (fromX !== null && fromY !== null) {
      ctx.beginPath();
      ctx.moveTo(fromX, fromY);
      ctx.lineTo(fx, fy);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(fx, fy, frameRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    const g = geomRef.current;
    if (!g) return;
    const { dx, dy } = getLocalPoint(e.nativeEvent);
    const p = displayToFrame(g, dx, dy);
    if (!p) return;

    pushHistory();
    drawingRef.current = true;
    paintAt(p.x, p.y, null, null);
    lastPt.current = p;
    renderOverlay();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingRef.current || disabled) return;
    e.preventDefault();

    const g = geomRef.current;
    if (!g) return;
    const { dx, dy } = getLocalPoint(e.nativeEvent);
    const p = displayToFrame(g, dx, dy);
    if (!p) return;

    const last = lastPt.current;
    paintAt(p.x, p.y, last?.x ?? null, last?.y ?? null);
    lastPt.current = p;
    renderOverlay();
  };

  const endStroke = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastPt.current = null;
    onStrokeEnd?.();
  };

  useImperativeHandle(ref, () => ({
    getMaskCanvas: () => maskRef.current,
    hasMask: () => {
      const mask = maskRef.current;
      if (!mask) return false;
      const ctx = mask.getContext('2d', { willReadFrequently: true })!;
      const d = ctx.getImageData(0, 0, mask.width, mask.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) return true;
      return false;
    },
    clear: () => {
      const mask = maskRef.current;
      if (!mask) return;
      pushHistory();
      mask.getContext('2d')!.clearRect(0, 0, mask.width, mask.height);
      renderOverlay();
    },
    undo: () => {
      const mask = maskRef.current;
      if (!mask || !historyRef.current.length) return;
      const ctx = mask.getContext('2d', { willReadFrequently: true })!;
      redoRef.current.push(ctx.getImageData(0, 0, mask.width, mask.height));
      const prev = historyRef.current.pop()!;
      ctx.putImageData(prev, 0, 0);
      renderOverlay();
      force((n) => n + 1);
    },
    redo: () => {
      const mask = maskRef.current;
      if (!mask || !redoRef.current.length) return;
      const ctx = mask.getContext('2d', { willReadFrequently: true })!;
      historyRef.current.push(ctx.getImageData(0, 0, mask.width, mask.height));
      const nxt = redoRef.current.pop()!;
      ctx.putImageData(nxt, 0, 0);
      renderOverlay();
      force((n) => n + 1);
    },
    loadFromCanvas: (src) => {
      const mask = maskRef.current;
      if (!mask) return;
      pushHistory();
      const ctx = mask.getContext('2d')!;
      ctx.clearRect(0, 0, mask.width, mask.height);
      ctx.drawImage(src, 0, 0, mask.width, mask.height);
      renderOverlay();
    },
  }));

  return (
    <div ref={wrapRef} className="absolute inset-0">
      <canvas
        ref={overlayRef}
        className="absolute inset-0 touch-none"
        style={{ cursor: disabled ? 'default' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerLeave={endStroke}
        onPointerCancel={endStroke}
      />
    </div>
  );
});

export default MaskCanvas;
