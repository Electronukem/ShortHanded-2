/* ═══════════════════════════════════════════════════════════════
   stroke-processor.js — Feature extraction and stroke clustering
   Exposed as: window.StrokeProcessor

   Pipeline stage 2 (after RDP simplification):
   ─────────────────────────────────────────────
   Input : array of simplified strokes, each being
           [{x, y, t, pressure?}, ...]

   Output: ShorthandPayload — the full JSON structure sent to the
           OCR worker / API.

   Feature extraction per stroke:
     • length          — arc-length of the simplified polyline
     • boundingBox     — {x, y, w, h, cx, cy}
     • direction       — dominant direction in 8 compass sectors
     • angles          — [segment angles in degrees, ...]
     • velocity        — average px/ms across segments
     • speedProfile    — [speed per segment, ...]
     • pressure        — {min, max, avg} (if available)
     • aspectRatio     — w/h of bounding box

   Clustering (word grouping):
     Strokes are grouped into "word clusters" by temporal and
     spatial proximity. A new cluster starts when:
       • gap since last stroke lift > TEMPORAL_GAP_MS, OR
       • spatial distance between stroke endpoints > SPATIAL_GAP_PX
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const StrokeProcessor = (() => {

  // ── Tuneable clustering thresholds ──────────────────────────
  const TEMPORAL_GAP_MS  = 600;   // ms between strokes → new word
  const SPATIAL_GAP_PX   = 80;    // px between stroke endpoints → new word

  // 8-sector compass quantisation
  const DIRECTIONS = ['E','NE','N','NW','W','SW','S','SE'];

  // ──────────────────────────────────────────────────────────────
  // Per-stroke feature extraction
  // ──────────────────────────────────────────────────────────────

  /**
   * Extract rich features from a single simplified stroke.
   *
   * @param {Array<{x,y,t,pressure?}>} pts   - simplified points
   * @param {number} strokeIndex
   * @returns {StrokeFeatures}
   */
  function extractFeatures(pts, strokeIndex) {
    const n = pts.length;

    if (n === 0) return null;

    // ── Arc length ──
    let arcLen = 0;
    const segLengths = [];
    for (let i = 1; i < n; i++) {
      const d = GeoUtils.dist(pts[i - 1], pts[i]);
      segLengths.push(d);
      arcLen += d;
    }

    // ── Bounding box ──
    const bbox = GeoUtils.boundingBox(pts);

    // ── Per-segment angles (degrees) ──
    const angles = [];
    for (let i = 1; i < n; i++) {
      angles.push(GeoUtils.angleDeg(pts[i - 1], pts[i]));
    }

    // ── Dominant direction ──
    const dominantAngle = angles.length
      ? angles.reduce((sum, a) => sum + a, 0) / angles.length
      : 0;
    const sector = Math.round(dominantAngle / 45) % 8;
    const direction = DIRECTIONS[sector];

    // ── Velocity / speed (px/ms) ──
    const speedProfile = [];
    let totalSpeed = 0;
    let speedSamples = 0;
    for (let i = 1; i < n; i++) {
      const dt = (pts[i].t || 0) - (pts[i - 1].t || 0);
      if (dt > 0) {
        const spd = segLengths[i - 1] / dt;
        speedProfile.push(+spd.toFixed(4));
        totalSpeed += spd;
        speedSamples++;
      } else {
        speedProfile.push(null);
      }
    }
    const avgVelocity = speedSamples > 0
      ? +(totalSpeed / speedSamples).toFixed(4)
      : null;

    // ── Pressure ──
    let pressure = null;
    if (pts[0] && pts[0].pressure != null) {
      const pressures = pts.map(p => p.pressure);
      pressure = {
        min: +Math.min(...pressures).toFixed(3),
        max: +Math.max(...pressures).toFixed(3),
        avg: +(pressures.reduce((s, v) => s + v, 0) / pressures.length).toFixed(3)
      };
    }

    // ── Aspect ratio ──
    const aspectRatio = bbox.h > 0 ? +(bbox.w / bbox.h).toFixed(3) : null;

    // ── Curvature (angular change per unit length) ──
    let totalAngleChange = 0;
    for (let i = 1; i < angles.length; i++) {
      let delta = Math.abs(angles[i] - angles[i - 1]);
      if (delta > 180) delta = 360 - delta;
      totalAngleChange += delta;
    }
    const curvature = arcLen > 0 ? +(totalAngleChange / arcLen).toFixed(4) : 0;

    // ── Normalised stroke (64 pts, arc-length resampled) ──
    // Used as input vector for the ML classifier stub
    const normalised = GeoUtils.resampleByArcLength(pts, 64).map(p => [
      +p.x.toFixed(2), +p.y.toFixed(2)
    ]);

    return {
      index:       strokeIndex,
      pointCount:  n,
      arcLength:   +arcLen.toFixed(2),
      boundingBox: {
        x:  +bbox.x.toFixed(2),
        y:  +bbox.y.toFixed(2),
        w:  +bbox.w.toFixed(2),
        h:  +bbox.h.toFixed(2),
        cx: +bbox.cx.toFixed(2),
        cy: +bbox.cy.toFixed(2)
      },
      direction,
      dominantAngle: +dominantAngle.toFixed(1),
      angles:      angles.map(a => +a.toFixed(1)),
      avgVelocity,
      speedProfile,
      pressure,
      aspectRatio,
      curvature,
      normalised,           // 64×2 float array for ML
      start: { x: pts[0].x, y: pts[0].y, t: pts[0].t || null },
      end:   { x: pts[n-1].x, y: pts[n-1].y, t: pts[n-1].t || null }
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Temporal + spatial clustering
  // ──────────────────────────────────────────────────────────────

  /**
   * Group stroke features into word clusters.
   *
   * @param {StrokeFeatures[]} features
   * @returns {WordCluster[]}
   */
  function clusterStrokes(features) {
    if (!features.length) return [];

    const clusters = [];
    let current = [features[0]];

    for (let i = 1; i < features.length; i++) {
      const prev = features[i - 1];
      const curr = features[i];

      // Temporal gap between end of previous stroke and start of current
      const tGap = (curr.start.t != null && prev.end.t != null)
        ? curr.start.t - prev.end.t
        : 0;

      // Spatial gap between endpoint of previous stroke and start of current
      const sGap = GeoUtils.dist(prev.end, curr.start);

      const newCluster = tGap > TEMPORAL_GAP_MS || sGap > SPATIAL_GAP_PX;

      if (newCluster) {
        clusters.push(buildCluster(current, clusters.length));
        current = [curr];
      } else {
        current.push(curr);
      }
    }
    // Push last cluster
    clusters.push(buildCluster(current, clusters.length));

    return clusters;
  }

  /**
   * Build a WordCluster descriptor from a group of stroke features.
   *
   * @param {StrokeFeatures[]} strokeFeatures
   * @param {number} clusterIndex
   * @returns {WordCluster}
   */
  function buildCluster(strokeFeatures, clusterIndex) {
    // Union bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const sf of strokeFeatures) {
      const bb = sf.boundingBox;
      if (bb.x < minX) minX = bb.x;
      if (bb.y < minY) minY = bb.y;
      if (bb.x + bb.w > maxX) maxX = bb.x + bb.w;
      if (bb.y + bb.h > maxY) maxY = bb.y + bb.h;
    }
    const w = maxX - minX;
    const h = maxY - minY;

    // Timing
    const tStart = strokeFeatures[0].start.t;
    const tEnd   = strokeFeatures[strokeFeatures.length - 1].end.t;

    // Combined direction sequence (per-stroke direction labels)
    const dirSequence = strokeFeatures.map(sf => sf.direction);

    return {
      index: clusterIndex,
      strokeCount: strokeFeatures.length,
      strokeIndices: strokeFeatures.map(sf => sf.index),
      boundingBox: {
        x: +minX.toFixed(2),
        y: +minY.toFixed(2),
        w: +w.toFixed(2),
        h: +h.toFixed(2),
        cx: +(minX + w / 2).toFixed(2),
        cy: +(minY + h / 2).toFixed(2)
      },
      directionSequence: dirSequence,
      tStart,
      tEnd,
      duration: (tStart != null && tEnd != null) ? tEnd - tStart : null
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Full pipeline: raw strokes → ShorthandPayload
  // ──────────────────────────────────────────────────────────────

  /**
   * Process raw strokes through RDP + feature extraction + clustering.
   *
   * @param {Array<Array<{x,y,t,pressure?}>>} rawStrokes
   * @param {number} rdpEpsilon
   * @param {boolean} useSmoothing
   * @returns {ShorthandPayload}
   */
  function buildPayload(rawStrokes, rdpEpsilon = 3, useSmoothing = false) {
    const ts = Date.now();

    // 1. Optionally smooth raw strokes before RDP
    const pre = useSmoothing
      ? rawStrokes.map(s => GeoUtils.movingAverage(s, 2))
      : rawStrokes;

    // 2. RDP simplification
    const simplified = RDP.simplifyStrokes(pre, rdpEpsilon);

    // 3. Stats
    const rawTotal  = rawStrokes.reduce((s, st) => s + st.length, 0);
    const simpTotal = simplified.reduce((s, st) => s + st.length, 0);
    const stats     = RDP.reductionStats(rawTotal, simpTotal);

    // 4. Feature extraction per stroke
    const features = simplified.map((pts, i) => extractFeatures(pts, i));

    // 5. Cluster into word groups
    const clusters = clusterStrokes(features.filter(Boolean));

    // 6. Assemble payload
    return {
      version:    '1.0',
      timestamp:  ts,
      settings: {
        rdpEpsilon,
        useSmoothing
      },
      stats: {
        rawPointCount:        rawTotal,
        simplifiedPointCount: simpTotal,
        reductionPercent:     stats.percent,
        compressionRatio:     stats.ratio,
        strokeCount:          rawStrokes.length,
        clusterCount:         clusters.length
      },
      strokes:  features,
      clusters,
      // Flat list of all simplified points per stroke (for the OCR engine)
      simplifiedStrokes: simplified.map(pts =>
        pts.map(p => ({ x: p.x, y: p.y, t: p.t || null }))
      )
    };
  }

  // ──────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────
  return {
    extractFeatures,
    clusterStrokes,
    buildPayload,
    TEMPORAL_GAP_MS,
    SPATIAL_GAP_PX
  };

})();

window.StrokeProcessor = StrokeProcessor;
