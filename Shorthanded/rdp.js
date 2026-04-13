/* ═══════════════════════════════════════════════════════════════
   rdp.js — Ramer–Douglas–Peucker stroke simplification
   Exposed as: window.RDP

   Algorithm overview
   ──────────────────
   Given a polyline of N points and an epsilon tolerance ε:
   1. Find the point with maximum perpendicular distance from the
      line connecting the first and last point.
   2. If that max distance > ε, split at that point and recurse
      on both halves.
   3. If max distance ≤ ε, discard all intermediate points —
      the endpoints alone are sufficient to represent this segment.

   Complexity: O(N log N) average, O(N²) worst case.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const RDP = (() => {

  // ──────────────────────────────────────────────────────────────
  // Core geometry: perpendicular distance from point P to line AB
  // ──────────────────────────────────────────────────────────────

  /**
   * Squared perpendicular distance from point P to the segment AB.
   * Using squared distances avoids sqrt in the inner loop — we only
   * need relative comparisons until we select the max.
   *
   * @param {number} px
   * @param {number} py
   * @param {number} ax  - line start x
   * @param {number} ay  - line start y
   * @param {number} bx  - line end x
   * @param {number} by  - line end y
   * @returns {number}   - squared perpendicular distance
   */
  function perpendicularDistanceSq(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
      // A and B are the same point — return distance P→A
      const ex = px - ax;
      const ey = py - ay;
      return ex * ex + ey * ey;
    }

    // Project P onto the infinite line through A,B; clamp to segment [0,1]
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const nearestX = ax + t * dx;
    const nearestY = ay + t * dy;

    const ex = px - nearestX;
    const ey = py - nearestY;
    return ex * ex + ey * ey;
  }

  // ──────────────────────────────────────────────────────────────
  // Iterative RDP (avoids call-stack overflow on long strokes)
  // ──────────────────────────────────────────────────────────────

  /**
   * Simplify an array of points using the RDP algorithm.
   *
   * @param {Array<{x:number, y:number, t?:number, pressure?:number}>} points
   * @param {number} epsilon  - max allowed deviation (pixels)
   * @returns {Array<{x:number, y:number, t?:number, pressure?:number}>}
   */
  function simplify(points, epsilon) {
    if (!points || points.length < 3) return points ? points.slice() : [];

    const epsilonSq = epsilon * epsilon;   // compare squared distances

    // Boolean mask: true = keep this point
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;

    // Iterative stack instead of recursion
    // Each entry is [startIndex, endIndex] of a sub-segment to examine
    const stack = [[0, points.length - 1]];

    while (stack.length > 0) {
      const [start, end] = stack.pop();

      if (end - start < 2) continue;   // nothing between endpoints

      const ax = points[start].x, ay = points[start].y;
      const bx = points[end].x,   by = points[end].y;

      let maxDistSq = 0;
      let maxIdx    = start;

      for (let i = start + 1; i < end; i++) {
        const distSq = perpendicularDistanceSq(
          points[i].x, points[i].y, ax, ay, bx, by
        );
        if (distSq > maxDistSq) {
          maxDistSq = distSq;
          maxIdx    = i;
        }
      }

      if (maxDistSq > epsilonSq) {
        keep[maxIdx] = 1;
        stack.push([start, maxIdx]);
        stack.push([maxIdx, end]);
      }
    }

    // Collect kept points in original order
    const result = [];
    for (let i = 0; i < points.length; i++) {
      if (keep[i]) result.push(points[i]);
    }
    return result;
  }

  // ──────────────────────────────────────────────────────────────
  // Batch helper: simplify every stroke in an array
  // ──────────────────────────────────────────────────────────────

  /**
   * @param {Array<Array<{x,y,t?,pressure?}>>} strokes
   * @param {number} epsilon
   * @returns {Array<Array<{x,y,t?,pressure?}>>}
   */
  function simplifyStrokes(strokes, epsilon) {
    return strokes.map(s => simplify(s, epsilon));
  }

  // ──────────────────────────────────────────────────────────────
  // Stat helper
  // ──────────────────────────────────────────────────────────────

  /**
   * Returns reduction stats across all strokes.
   * @param {number} rawTotal
   * @param {number} simplifiedTotal
   */
  function reductionStats(rawTotal, simplifiedTotal) {
    if (rawTotal === 0) return { percent: 0, ratio: 1 };
    const percent = ((1 - simplifiedTotal / rawTotal) * 100).toFixed(1);
    const ratio   = (rawTotal / simplifiedTotal).toFixed(2);
    return { percent: +percent, ratio: +ratio };
  }

  // ──────────────────────────────────────────────────────────────
  // ██  UNIT TESTS  ██
  // Call RDP.runTests() from console or the toolbar button.
  // Returns an array of { name, passed, detail } objects.
  // ──────────────────────────────────────────────────────────────

  function runTests() {
    const results = [];

    function assert(name, condition, detail = '') {
      results.push({ name, passed: !!condition, detail });
      const icon = condition ? '✓' : '✗';
      const tag  = condition ? 'test' : 'error';
      if (window.Logger) {
        window.Logger.log(tag, `${icon} ${name}${detail ? ' — ' + detail : ''}`);
      } else {
        console[condition ? 'log' : 'error'](`[RDP TEST] ${icon} ${name}`, detail);
      }
    }

    // ── Test 1: empty and trivial inputs ──
    assert('Empty array returns []',
      simplify([], 1).length === 0);

    assert('Single point is returned unchanged',
      simplify([{x:0,y:0}], 1).length === 1);

    assert('Two points are returned unchanged',
      simplify([{x:0,y:0},{x:10,y:10}], 1).length === 2);

    // ── Test 2: perfectly collinear points ──
    // 5 points on a horizontal line → should reduce to endpoints only
    const collinear = [
      {x:0,y:5}, {x:2,y:5}, {x:5,y:5}, {x:8,y:5}, {x:10,y:5}
    ];
    const colResult = simplify(collinear, 1);
    assert('Collinear points reduce to 2 endpoints',
      colResult.length === 2,
      `got ${colResult.length}`);
    assert('Collinear: first point preserved',
      colResult[0].x === 0 && colResult[0].y === 5);
    assert('Collinear: last point preserved',
      colResult[colResult.length-1].x === 10 && colResult[colResult.length-1].y === 5);

    // ── Test 3: sharp corner must be retained ──
    // L-shape: right then up — the corner point has large deviation
    const lShape = [
      {x:0,y:0}, {x:5,y:0}, {x:10,y:0}, {x:10,y:5}, {x:10,y:10}
    ];
    const lResult = simplify(lShape, 1);
    assert('L-shape corner point retained',
      lResult.some(p => p.x === 10 && p.y === 0),
      `simplified to ${lResult.length} pts`);

    // ── Test 4: near-collinear with epsilon control ──
    // Slight deviation of 2px — should be kept with ε=1, dropped with ε=5
    const slightBump = [
      {x:0,y:0}, {x:5,y:2}, {x:10,y:0}
    ];
    const kept   = simplify(slightBump, 1);
    const dropped = simplify(slightBump, 5);
    assert('Point with deviation 2 kept when ε=1',
      kept.length === 3,
      `got ${kept.length}`);
    assert('Point with deviation 2 dropped when ε=5',
      dropped.length === 2,
      `got ${dropped.length}`);

    // ── Test 5: point ordering preserved ──
    const zigzag = [];
    for (let i = 0; i <= 20; i++) {
      zigzag.push({ x: i, y: (i % 2 === 0) ? 0 : 10 });
    }
    const zzResult = simplify(zigzag, 0.5);
    // All peaks and valleys should be kept (large deviation)
    assert('Zigzag: all key vertices retained with low ε',
      zzResult.length >= zigzag.length * 0.8,
      `${zzResult.length}/${zigzag.length} kept`);

    // Verify ordering
    let ordered = true;
    for (let i = 1; i < zzResult.length; i++) {
      if (zzResult[i].x < zzResult[i-1].x) { ordered = false; break; }
    }
    assert('Zigzag: output points in original x-order', ordered);

    // ── Test 6: large epsilon collapses everything to 2 points ──
    const dense = Array.from({length: 100}, (_, i) => ({
      x: i,
      y: Math.sin(i * 0.1) * 0.01   // essentially flat
    }));
    const collapsed = simplify(dense, 10);
    assert('Dense near-flat curve collapses to 2 points with large ε',
      collapsed.length === 2,
      `got ${collapsed.length}`);

    // ── Test 7: metadata (t, pressure) is preserved on kept points ──
    const withMeta = [
      {x:0, y:0, t:1000, pressure:0.5},
      {x:5, y:5, t:1050, pressure:0.8},
      {x:10,y:0, t:1100, pressure:0.3}
    ];
    const metaResult = simplify(withMeta, 1);
    const firstPt = metaResult[0];
    assert('Metadata (t, pressure) preserved on kept points',
      firstPt.t === 1000 && firstPt.pressure === 0.5);

    // ── Test 8: point reduction is meaningful on a smooth curve ──
    // 200-point sine wave
    const sine = Array.from({length: 200}, (_, i) => ({
      x: i,
      y: Math.sin(i * Math.PI / 20) * 30
    }));
    const sineSimp = simplify(sine, 2);
    assert('Sine curve is meaningfully reduced (>50% fewer points)',
      sineSimp.length < sine.length * 0.5,
      `${sineSimp.length}/${sine.length} kept`);

    // ── Test 9: first and last always kept ──
    const arbitrary = Array.from({length: 50}, (_, i) => ({
      x: Math.random() * 500,
      y: Math.random() * 400
    }));
    arbitrary[0]  = {x: 7,   y: 7};
    arbitrary[49] = {x: 493, y: 393};
    const arbResult = simplify(arbitrary, 3);
    assert('First point always kept',
      arbResult[0].x === 7 && arbResult[0].y === 7);
    assert('Last point always kept',
      arbResult[arbResult.length-1].x === 493 &&
      arbResult[arbResult.length-1].y === 393);

    // ── Summary ──
    const passed = results.filter(r => r.passed).length;
    const total  = results.length;
    if (window.Logger) {
      window.Logger.log(passed === total ? 'test' : 'error',
        `RDP tests: ${passed}/${total} passed`);
    } else {
      console.log(`[RDP TESTS] ${passed}/${total} passed`);
    }

    return results;
  }

  // ──────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────
  return {
    simplify,
    simplifyStrokes,
    reductionStats,
    perpendicularDistanceSq,  // exported for testing/debugging
    runTests
  };

})();

// Make available globally (used by app.js and ocr-worker.js)
window.RDP = RDP;
