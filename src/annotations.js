// Annotation model + rendering. All coordinates are normalized (0..1) to the page,
// so annotations line up on any screen size or zoom level.
//
// stroke: { type:'stroke', tool:'pen'|'highlighter', color, w, pts:[x0,y0,x1,y1,...] }  (w = width / page width)
// text:   { type:'text', x, y, text, color, size }                                      (size = font px / page width)
// shape:  { type:'shape', kind:'line'|'arrow'|'rect'|'ellipse', x1, y1, x2, y2, color, w }

export const COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#9333ea', '#facc15', '#ec4899'];
export const SHAPES = ['line', 'arrow', 'rect', 'ellipse'];
export const HIGHLIGHT_ALPHA = 0.35;

export const round = (n) => Math.round(n * 10000) / 10000;

export function strokeWidth(tool, sizeLevel) {
  // normalized to page width
  return tool === 'highlighter' ? 0.012 * sizeLevel : 0.0016 * sizeLevel;
}

function tracePath(ctx, pts, W, H) {
  const n = pts.length / 2;
  ctx.beginPath();
  if (n === 1) {
    ctx.moveTo(pts[0] * W, pts[1] * H);
    ctx.lineTo(pts[0] * W + 0.01, pts[1] * H);
    return;
  }
  ctx.moveTo(pts[0] * W, pts[1] * H);
  // Quadratic smoothing through midpoints.
  for (let i = 1; i < n - 1; i++) {
    const x = pts[i * 2] * W, y = pts[i * 2 + 1] * H;
    const nx = pts[i * 2 + 2] * W, ny = pts[i * 2 + 3] * H;
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  ctx.lineTo(pts[(n - 1) * 2] * W, pts[(n - 1) * 2 + 1] * H);
}

const FONT = (fs) => `600 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
let measureCtx = null;
function measureText(text, fs) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = FONT(fs);
  return measureCtx.measureText(text).width;
}

function textMetrics(item, W) {
  const fs = Math.max(8, item.size * W);
  const lines = item.text.split('\n');
  const lh = fs * 1.25;
  const pad = fs * 0.3;
  const width = Math.max(...lines.map((l) => measureText(l, fs)));
  return { fs, lines, lh, pad, width, height: lh * (lines.length - 1) + fs };
}

export function drawItem(ctx, item, W, H) {
  ctx.save();
  if (item.type === 'stroke') {
    ctx.lineCap = item.tool === 'highlighter' ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = item.color;
    ctx.lineWidth = Math.max(1, item.w * W);
    if (item.tool === 'highlighter') {
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.globalCompositeOperation = 'multiply';
    }
    tracePath(ctx, item.pts, W, H);
    ctx.stroke();
  } else if (item.type === 'shape') {
    const x1 = item.x1 * W, y1 = item.y1 * H, x2 = item.x2 * W, y2 = item.y2 * H;
    const lw = Math.max(1, item.w * W);
    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (item.kind === 'rect') {
      ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.stroke();
    } else if (item.kind === 'ellipse') {
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (item.kind === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.max(10, lw * 4);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
        ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
      }
    }
  } else if (item.type === 'text') {
    const m = textMetrics(item, W);
    ctx.font = FONT(m.fs);
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255, 250, 205, 0.92)';
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    const bx = item.x * W - m.pad, by = item.y * H - m.pad;
    ctx.fillRect(bx, by, m.width + m.pad * 2, m.height + m.pad * 2);
    ctx.strokeRect(bx, by, m.width + m.pad * 2, m.height + m.pad * 2);
    ctx.fillStyle = item.color;
    m.lines.forEach((l, i) => ctx.fillText(l, item.x * W, item.y * H + i * m.lh));
  }
  ctx.restore();
}

export function drawItems(ctx, items, W, H) {
  for (const it of items) drawItem(ctx, it, W, H);
}

/** Bounding box in pixels: {x, y, w, h}. */
export function bbox(item, W, H) {
  if (item.type === 'text') {
    const m = textMetrics(item, W);
    return { x: item.x * W - m.pad, y: item.y * H - m.pad, w: m.width + m.pad * 2, h: m.height + m.pad * 2 };
  }
  const half = ((item.w || 0) * W) / 2;
  let xs, ys;
  if (item.type === 'shape') {
    xs = [item.x1 * W, item.x2 * W];
    ys = [item.y1 * H, item.y2 * H];
  } else {
    xs = [];
    ys = [];
    for (let i = 0; i < item.pts.length; i += 2) { xs.push(item.pts[i] * W); ys.push(item.pts[i + 1] * H); }
  }
  const x = Math.min(...xs) - half, y = Math.min(...ys) - half;
  return { x, y, w: Math.max(...xs) + half - x, h: Math.max(...ys) + half - y };
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Is pixel point (px,py) within `r` pixels of the item? */
export function hitTest(item, px, py, r, W, H) {
  if (item.type === 'text') {
    const b = bbox(item, W, H);
    return px >= b.x - r && px <= b.x + b.w + r && py >= b.y - r && py <= b.y + b.h + r;
  }
  const tol = r + (item.w * W) / 2;
  if (item.type === 'shape') {
    const x1 = item.x1 * W, y1 = item.y1 * H, x2 = item.x2 * W, y2 = item.y2 * H;
    if (item.kind === 'rect') {
      const l = Math.min(x1, x2), rt = Math.max(x1, x2), t = Math.min(y1, y2), b = Math.max(y1, y2);
      return [[l, t, rt, t], [rt, t, rt, b], [rt, b, l, b], [l, b, l, t]].some((s) => distToSeg(px, py, ...s) <= tol);
    }
    if (item.kind === 'ellipse') {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const rx = Math.max(1, Math.abs(x2 - x1) / 2), ry = Math.max(1, Math.abs(y2 - y1) / 2);
      const d = Math.hypot((px - cx) / rx, (py - cy) / ry);
      return Math.abs(d - 1) * Math.min(rx, ry) <= tol;
    }
    return distToSeg(px, py, x1, y1, x2, y2) <= tol;
  }
  const pts = item.pts;
  if (pts.length === 2) return Math.hypot(px - pts[0] * W, py - pts[1] * H) <= tol;
  for (let i = 0; i < pts.length - 2; i += 2) {
    if (distToSeg(px, py, pts[i] * W, pts[i + 1] * H, pts[i + 2] * W, pts[i + 3] * H) <= tol) return true;
  }
  return false;
}

/** Move an item by (dx, dy) in normalized units (mutates). */
export function translate(item, dx, dy) {
  if (item.type === 'text') {
    item.x = round(item.x + dx);
    item.y = round(item.y + dy);
  } else if (item.type === 'shape') {
    item.x1 = round(item.x1 + dx); item.x2 = round(item.x2 + dx);
    item.y1 = round(item.y1 + dy); item.y2 = round(item.y2 + dy);
  } else {
    for (let i = 0; i < item.pts.length; i += 2) {
      item.pts[i] = round(item.pts[i] + dx);
      item.pts[i + 1] = round(item.pts[i + 1] + dy);
    }
  }
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is the item (mostly) inside a lasso polygon? poly = flat [x,y,...] in pixels. */
export function inLasso(item, poly, W, H) {
  let pts;
  if (item.type === 'stroke') {
    pts = [];
    for (let i = 0; i < item.pts.length; i += 2) pts.push([item.pts[i] * W, item.pts[i + 1] * H]);
  } else {
    const b = bbox(item, W, H);
    pts = [[b.x + b.w / 2, b.y + b.h / 2], [b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
  }
  const inside = pts.filter(([x, y]) => pointInPolygon(x, y, poly)).length;
  return inside / pts.length >= 0.6;
}

export function traceLasso(ctx, poly) {
  if (poly.length < 4) return;
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#4f46e5';
  ctx.fillStyle = 'rgba(79, 70, 229, 0.08)';
  ctx.beginPath();
  ctx.moveTo(poly[0], poly[1]);
  for (let i = 2; i < poly.length; i += 2) ctx.lineTo(poly[i], poly[i + 1]);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
