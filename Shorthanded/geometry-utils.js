/* ═══════════════════════════════════════════════════════════════
   geometry-utils.js — Point math, smoothing, and spline helpers
   Exposed as: window.GeoUtils
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const GeoUtils = (() => {

  // ──────────────────────────────────────────────────────────────
  // Basic point operations
  // ──────────────────────────────────────────────────────────────

  /** Euclidean distance between two points */
  function dist(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Squared distance (cheaper, use when you only need relative comparisons) */
  function distSq(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return dx * dx + dy * dy;
  }

  /** Angle in radians from point a to point b, range [-π, π] */
  function angle(a, b) {
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  /** Angle in degrees [0, 360) */
  function angleDeg(a, b) {
    const rad = angle(a, b);
    return ((rad * 180 / Math.PI) + 360) % 360;
  }

  /** Linear interpolate between two numbers */
  function lerp(a, b, t) { return a + (b - a) * t; }

  /** Bounding box of a point array. Returns {x,y,w,h,cx,cy}. */
  function boundingBox(points) {
    if (!points.length) return { x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const w = maxX - minX;
    const h = maxY - minY;
    return { x: minX, y: minY, w, h, cx: minX + w / 2, cy: minY + h / 2 };
  }

  // ──────────────────────────────────────────────────────────────
  // Moving-average smoothing
  // ──────────────────────────────────────────────────────────────

  /**
   * Smooth a stroke with a simple moving average over a window of ±radius.
   * Preserves first/last points exactly (no boundary smearing).
   *
   * @param {Array<{x,y,...}>} points
   * @param {number} radius   - number of neighbours on each side (1 = window of 3)
   * @returns {Array<{x,y,...}>}
   */
  function movingAverage(points, radius = 1) {
    if (points.length <= 2) return points.slice();
    const out = [];
    for (let i = 0; i < points.length; i++) {
      if (i === 0 || i === points.length - 1) {
        out.push(points[i]);
        continue;
      }
      const lo = Math.max(0, i - radius);
      const hi = Math.min(points.length - 1, i + radius);
      let sx = 0, sy = 0, n = 0;
      for (let j = lo; j <= hi; j++) {
        sx += points[j].x;
        sy += points[j].y;
        n++;
      }
      out.push({ ...points[i], x: sx / n, y: sy / n });
    }
    return out;
  }

  // ──────────────────────────────────────────────────────────────
  // Catmull-Rom spline interpolation
  // ──────────────────────────────────────────────────────────────

  /**
   * Evaluate a Catmull-Rom spline at parameter t ∈ [0,1] through the
   * four control points p0, p1, p2, p3.
   * Returns {x, y}.
   *
   * Uses the standard centripetal (alpha=0.5) parameterisation.
   */
  function catmullRomPoint(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    // Cubic hermite form (uniform parameterisation, tension=0.5)
    const x = 0.5 * (
      ( 2 * p1.x) +
      (-p0.x + p2.x) * t +
      ( 2*p0.x - 5*p1.x + 4*p2.x - p3.x) * t2 +
      (-p0.x + 3*p1.x - 3*p2.x + p3.x) * t3
    );
    const y = 0.5 * (
      ( 2 * p1.y) +
      (-p0.y + p2.y) * t +
      ( 2*p0.y - 5*p1.y + 4*p2.y - p3.y) * t2 +
      (-p0.y + 3*p1.y - 3*p2.y + p3.y) * t3
    );
    return { x, y };
  }

  /**
   * Resample an entire stroke as a Catmull-Rom spline.
   * Inserts `samplesPerSegment` interpolated points between each pair of
   * original knots — use AFTER RDP simplification to re-render smooth curves
   * for display (not for analysis — analysis uses the RDP points directly).
   *
   * @param {Array<{x,y,...}>} points   - control knots (≥ 2)
   * @param {number} samplesPerSegment  - interpolated points between each pair
   * @returns {Array<{x,y}>}            - display-only smoothed path
   */
  function catmullRomSpline(points, samplesPerSegment = 8) {
    if (points.length < 2) return points.map(p => ({ x: p.x, y: p.y }));
    if (points.length === 2) {
      // No interior knots — just interpolate linearly
      const out = [];
      for (let s = 0; s <= samplesPerSegment; s++) {
        const t = s / samplesPerSegment;
        out.push({ x: lerp(points[0].x, points[1].x, t),
                   y: lerp(points[0].y, points[1].y, t) });
      }
      return out;
    }

    const out = [];
    // Ghost-point extrapolation at both ends
    const phantom0 = {
      x: 2 * points[0].x - points[1].x,
      y: 2 * points[0].y - points[1].y
    };
    const last = points.length - 1;
    const phantomN = {
      x: 2 * points[last].x - points[last - 1].x,
      y: 2 * points[last].y - points[last - 1].y
    };

    const ctrl = [phantom0, ...points, phantomN];

    for (let i = 1; i < ctrl.length - 2; i++) {
      const p0 = ctrl[i - 1];
      const p1 = ctrl[i];
      const p2 = ctrl[i + 1];
      const p3 = ctrl[i + 2];

      const steps = (i === ctrl.length - 3) ? samplesPerSegment + 1 : samplesPerSegment;
      for (let s = 0; s < steps; s++) {
        const t = s / samplesPerSegment;
        out.push(catmullRomPoint(p0, p1, p2, p3, t));
      }
    }

    return out;
  }

  // ──────────────────────────────────────────────────────────────
  // Arc-length re-parameterisation
  // ──────────────────────────────────────────────────────────────

  /**
   * Resample points evenly along arc-length.
   * Returns `n` points spaced uniformly by distance along the path.
   * Useful for normalising strokes before ML classification.
   *
   * @param {Array<{x,y}>} points
   * @param {number} n  - desired number of output points
   * @returns {Array<{x,y}>}
   */
  function resampleByArcLength(points, n = 64) {
    if (points.length < 2) return points.slice();

    // Build cumulative arc-length table
    const cumLen = [0];
    for (let i = 1; i < points.length; i++) {
      cumLen.push(cumLen[i - 1] + dist(points[i - 1], points[i]));
    }
    const totalLen = cumLen[cumLen.length - 1];
    if (totalLen === 0) return Array(n).fill({ x: points[0].x, y: points[0].y });

    const out = [];
    let pIdx = 0;

    for (let i = 0; i < n; i++) {
      const targetLen = (i / (n - 1)) * totalLen;

      // Advance segment pointer
      while (pIdx < cumLen.length - 2 && cumLen[pIdx + 1] < targetLen) pIdx++;

      const segStart = cumLen[pIdx];
      const segEnd   = cumLen[pIdx + 1];
      const segLen   = segEnd - segStart;
      const t = segLen === 0 ? 0 : (targetLen - segStart) / segLen;

      out.push({
        x: lerp(points[pIdx].x, points[pIdx + 1].x, t),
        y: lerp(points[pIdx].y, points[pIdx + 1].y, t)
      });
    }

    return out;
  }

  // ──────────────────────────────────────────────────────────────
  // Canvas drawing helpers (used by app.js overlays)
  // ──────────────────────────────────────────────────────────────

  /**
   * Draw a polyline of {x,y} points onto a 2D canvas context.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array<{x,y}>} points
   */
  function drawPolyline(ctx, points) {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  /**
   * Draw dot markers at each point (for RDP overlay debugging).
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array<{x,y}>} points
   * @param {number} r  - dot radius
   */
  function drawDots(ctx, points, r = 3) {
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Draw a bounding rectangle.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x,y,w,h}} bbox
   * @param {number} padding
   */
  function drawBBox(ctx, bbox, padding = 4) {
    ctx.strokeRect(
      bbox.x - padding,
      bbox.y - padding,
      bbox.w + padding * 2,
      bbox.h + padding * 2
    );
  }

  // ──────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────
  return {
    dist,
    distSq,
    angle,
    angleDeg,
    lerp,
    boundingBox,
    movingAverage,
    catmullRomSpline,
    resampleByArcLength,
    drawPolyline,
    drawDots,
    drawBBox
  };

})();

window.GeoUtils = GeoUtils;
