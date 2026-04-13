/* ═══════════════════════════════════════════════════════════════
   dtw.js — Dynamic Time Warping stroke matcher + macro dictionary
   Exposed as: window.DTW (main thread) / self.DTW (Web Worker)
   ───────────────────────────────────────────────────────────────
   PIPELINE
   ────────
   Raw strokes  →  RDP.simplify()  →  DTW.strokesToSequence()
                                            │
                                   normalize()  +  resampleN()
                                            │
                                    fixed-length float sequence
                                            │
                                    DTW.match()  vs  _dict[]
                                            │
                                    ranked results  →  UI

   NORMALIZATION
   ─────────────
   1. Translate so bounding-box top-left corner → (0, 0)
   2. Scale uniformly so the longest bounding-box dimension → 1.0
      (aspect ratio is preserved — a circle stays circular)
   3. Result: all coordinates in [0, 1] space

   WHY UNIFORM SCALE: If we stretched X and Y independently, a
   wide horizontal dash and a tall vertical dash would both
   normalize to a near-identical diagonal, breaking the match.
   Uniform scale keeps the shape's aspect ratio meaningful.

   DTW ALGORITHM
   ─────────────
   Standard DTW with two optimisations:
     1. Sakoe-Chiba band  — only evaluates cells within ±W of the
        diagonal, where W = max(|n-m|, ceil(max(n,m) × windowFrac)).
        This gives O(N × W) time and makes large-N comparisons fast.

     2. Rolling two-row buffer  — only keeps the previous and current
        rows of the N×M cost matrix in memory, giving O(N) space.

   DISTANCE SCORE
   ──────────────
   The raw DTW cost is divided by the sequence length N to give a
   "per-point average Euclidean distance" in normalised [0,1] space.
   Interpretation:
     < 0.10   excellent match
     0.10–0.20  good match
     0.20–0.35  moderate / borderline
     > 0.35   likely different shape

   DICTIONARY PERSISTENCE
   ──────────────────────
   Templates are stored in localStorage under key 'shorthanded_dict_v1'.
   Each entry holds the resampled, normalised sequence as a compact
   float array so no re-processing is needed on load.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const DTW = (() => {

  const DEFAULT_N    = 32;    // points per template sequence
  const STORAGE_KEY  = 'shorthanded_dict_v1';

  // ──────────────────────────────────────────────────────────────
  // 1. Vector normalisation
  // ──────────────────────────────────────────────────────────────

  /**
   * Translate and uniformly scale a point array so its bounding box
   * starts at (0, 0) and fits within the unit square [0,1]×[0,1].
   *
   * Uniform scale preserves aspect ratio.
   * Degenerate inputs (single point or collinear near-zero extent)
   * are centred at (0.5, 0.5) to avoid division-by-zero.
   *
   * @param {Array<{x:number, y:number}>} points
   * @returns {Array<{x:number, y:number}>}
   */
  function normalize(points) {
    if (!points || points.length === 0) return [];

    let minX = Infinity, minY = Infinity,
        maxX = -Infinity, maxY = -Infinity;

    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    const w = maxX - minX;
    const h = maxY - minY;
    const scale = Math.max(w, h);   // uniform: longest axis → 1.0

    if (scale < 1e-9) {
      // Degenerate: all points coincident (e.g., a tap, a dot)
      return points.map(() => ({ x: 0.5, y: 0.5 }));
    }

    return points.map(p => ({
      x: (p.x - minX) / scale,
      y: (p.y - minY) / scale
    }));
  }

  // ──────────────────────────────────────────────────────────────
  // 2. Arc-length resampling
  // ──────────────────────────────────────────────────────────────

  /**
   * Resample a point array to exactly n points spaced uniformly
   * along the cumulative arc length.
   * Self-contained (does not depend on GeoUtils) so it can run
   * in a Web Worker context too.
   *
   * @param {Array<{x,y}>} pts
   * @param {number} n
   * @returns {Array<{x,y}>}
   */
  function resampleN(pts, n) {
    if (!pts || pts.length === 0) return [];
    if (pts.length === 1) return Array(n).fill({ x: pts[0].x, y: pts[0].y });
    if (n === 1) return [{ x: pts[0].x, y: pts[0].y }];

    // Build cumulative chord-length table
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    const totalLen = cum[cum.length - 1];
    if (totalLen < 1e-9) return Array(n).fill({ x: pts[0].x, y: pts[0].y });

    const out = [];
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const target = (i / (n - 1)) * totalLen;
      // Advance segment pointer
      while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
      const segLen = cum[seg + 1] - cum[seg];
      const t = segLen < 1e-9 ? 0 : (target - cum[seg]) / segLen;
      out.push({
        x: pts[seg].x + t * (pts[seg + 1].x - pts[seg].x),
        y: pts[seg].y + t * (pts[seg + 1].y - pts[seg].y)
      });
    }
    return out;
  }

  // ──────────────────────────────────────────────────────────────
  // 3. Stroke → comparable sequence
  // ──────────────────────────────────────────────────────────────

  /**
   * Convert an array of simplified strokes into a single normalised,
   * arc-length-resampled point sequence ready for DTW comparison.
   *
   * Steps:
   *   1. Concatenate all stroke point arrays in draw order
   *   2. Normalise (translate + uniform scale)
   *   3. Resample to exactly N points by arc length
   *
   * This produces a representation that is invariant to:
   *   • Position on canvas
   *   • Overall size
   *   • Drawing speed (via arc-length resampling)
   *   • Number of raw points captured
   *
   * @param {Array<Array<{x:number,y:number}>>} strokes
   * @param {number} [N=DEFAULT_N]
   * @returns {Array<{x,y}>}  length N (or empty if input is empty)
   */
  function strokesToSequence(strokes, N = DEFAULT_N) {
    if (!strokes || strokes.length === 0) return [];
    const flat = [];
    for (const s of strokes) for (const p of s) flat.push(p);
    if (flat.length === 0) return [];
    return resampleN(normalize(flat), N);
  }

  // ──────────────────────────────────────────────────────────────
  // 4. DTW algorithm (Sakoe-Chiba band, two-row rolling buffer)
  // ──────────────────────────────────────────────────────────────

  /**
   * Euclidean distance between two 2D points.
   * @param {{x,y}} a
   * @param {{x,y}} b
   * @returns {number}
   */
  function pointDist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Dynamic Time Warping distance between two point sequences.
   *
   * Uses a Sakoe-Chiba band of width:
   *   W = max( |n - m|, ceil(max(n, m) × windowFrac) )
   *
   * The band ensures a valid warping path always exists (|n-m| is the
   * minimum band that allows the path from (1,1) to (n,m)), while
   * windowFrac limits unnecessary warping.
   *
   * Returns the raw accumulated cost. Divide by N to get a
   * per-point average for threshold comparisons.
   *
   * @param {Array<{x,y}>} a
   * @param {Array<{x,y}>} b
   * @param {number} [windowFrac=0.15]
   * @returns {number}
   */
  function dtw(a, b, windowFrac = 0.15) {
    const n = a.length, m = b.length;
    if (n === 0 || m === 0) return 0;
    if (n === 1 && m === 1) return pointDist(a[0], b[0]);

    const w   = Math.max(Math.abs(n - m), Math.ceil(Math.max(n, m) * windowFrac));
    const INF = 1e9;

    // Two-row rolling buffer (1-indexed: index 0 is the "before start" sentinel)
    let prev = new Float64Array(m + 1).fill(INF);
    let curr = new Float64Array(m + 1).fill(INF);
    prev[0] = 0;  // origin sentinel: cost before any element is zero

    for (let i = 1; i <= n; i++) {
      curr.fill(INF);
      const jLo = Math.max(1, i - w);
      const jHi = Math.min(m, i + w);
      for (let j = jLo; j <= jHi; j++) {
        const cost = pointDist(a[i - 1], b[j - 1]);
        // Three predecessors: diagonal, above, left
        const best = prev[j - 1] < prev[j]
          ? (prev[j - 1] < curr[j - 1] ? prev[j - 1] : curr[j - 1])
          : (prev[j]     < curr[j - 1] ? prev[j]     : curr[j - 1]);
        curr[j] = cost + best;
      }
      // Swap buffers without allocation
      const tmp = prev; prev = curr; curr = tmp;
    }

    return prev[m] >= INF ? INF : prev[m];
  }

  /**
   * Normalised DTW distance (per-point average).
   * Use this for threshold comparisons.
   *
   * @param {Array<{x,y}>} a
   * @param {Array<{x,y}>} b
   * @param {number} [windowFrac=0.15]
   * @returns {number}  in [0, ∞), typically < 1 for similar shapes
   */
  function dtwNorm(a, b, windowFrac = 0.15) {
    const N = Math.max(a.length, b.length);
    return N > 0 ? dtw(a, b, windowFrac) / N : 0;
  }

  // ──────────────────────────────────────────────────────────────
  // 5. Dictionary — save, match, persist
  // ──────────────────────────────────────────────────────────────

  const _dict  = {};    // { [id]: TemplateEntry }
  let   _nextId = 1;

  // ── LocalStorage persistence ──

  function _persist() {
    try {
      localStorage.setItem(STORAGE_KEY,
        JSON.stringify({ version: 1, entries: Object.values(_dict) })
      );
    } catch (e) {
      console.warn('[DTW] localStorage save failed:', e.message);
    }
  }

  function _loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const entry of (data.entries || [])) {
        // Re-hydrate sequence arrays (JSON stores plain objects)
        entry.sequence = entry.sequence.map(p => ({ x: p.x, y: p.y }));
        _dict[entry.id] = entry;
        if (entry.id >= _nextId) _nextId = entry.id + 1;
      }
    } catch (e) {
      console.warn('[DTW] localStorage load failed:', e.message);
    }
  }

  // ── CRUD ──

  /**
   * Save a new macro template from the current canvas strokes.
   *
   * The strokes are normalised and resampled to N points before
   * storage — subsequent draws are compared against this fixed
   * representation regardless of size or speed.
   *
   * @param {string} text                           - macro expansion text
   * @param {Array<Array<{x,y}>>} simplifiedStrokes - RDP-simplified strokes
   * @param {number} [N=DEFAULT_N]                  - sequence length
   * @returns {TemplateEntry}
   */
  function save(text, simplifiedStrokes, N = DEFAULT_N) {
    const sequence = strokesToSequence(simplifiedStrokes, N);
    const entry = {
      id:          _nextId++,
      text:        text.trim(),
      sequence,
      strokeCount: simplifiedStrokes.length,
      N,
      timestamp:   Date.now()
    };
    _dict[entry.id] = entry;
    _persist();
    return entry;
  }

  /**
   * Run DTW against every template and return results sorted by
   * ascending normalised distance.
   *
   * Only results below `threshold` are marked as matches, but ALL
   * results are returned so the caller can log scores and adjust
   * the threshold interactively.
   *
   * @param {Array<Array<{x,y}>>} simplifiedStrokes  - current drawing
   * @param {number} [threshold=0.25]
   * @param {number} [N=DEFAULT_N]
   * @returns {MatchResult[]}  sorted ascending by distance
   */
  function match(simplifiedStrokes, threshold = 0.25, N = DEFAULT_N) {
    const entries = Object.values(_dict);
    if (entries.length === 0) return [];

    const query = strokesToSequence(simplifiedStrokes, N);
    if (query.length === 0) return [];

    const results = [];
    for (const entry of entries) {
      // Re-resample stored sequence if its N differs from query N
      const tmpl   = (entry.N === N) ? entry.sequence : resampleN(entry.sequence, N);
      const rawCost = dtw(query, tmpl);
      const dist    = rawCost / N;  // normalised per-point distance

      results.push({
        id:          entry.id,
        text:        entry.text,
        distance:    +dist.toFixed(5),
        rawDtw:      +rawCost.toFixed(3),
        strokeCount: entry.strokeCount,
        matched:     dist <= threshold
      });
    }

    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  /**
   * Delete a template by id.
   * @param {number} id
   */
  function remove(id) {
    delete _dict[id];
    _persist();
  }

  /**
   * Export the full dictionary as a pretty-printed JSON string.
   * @returns {string}
   */
  function exportJSON() {
    return JSON.stringify({ version: 1, entries: Object.values(_dict) }, null, 2);
  }

  /**
   * Import templates from a JSON string exported by exportJSON().
   * Merges into the existing dictionary (new IDs are assigned to
   * avoid collisions).
   *
   * @param {string} json
   * @returns {number}  number of entries imported
   */
  function importJSON(json) {
    const data = JSON.parse(json);
    let count = 0;
    for (const entry of (data.entries || [])) {
      const imported = {
        ...entry,
        id:       _nextId++,
        sequence: entry.sequence.map(p => ({ x: p.x, y: p.y }))
      };
      _dict[imported.id] = imported;
      count++;
    }
    _persist();
    return count;
  }

  /**
   * List all templates (without the raw sequence data).
   * @returns {TemplateSummary[]}
   */
  function list() {
    return Object.values(_dict)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(e => ({
        id:          e.id,
        text:        e.text,
        strokeCount: e.strokeCount,
        N:           e.N,
        timestamp:   e.timestamp
      }));
  }

  /** Count of saved templates. */
  function count() { return Object.keys(_dict).length; }

  /** Check if the dictionary is empty. */
  function isEmpty() { return Object.keys(_dict).length === 0; }

  // Load persisted templates when module is first evaluated
  if (typeof localStorage !== 'undefined') {
    _loadFromStorage();
  }

  // ──────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────
  return {
    // Standalone utilities (also used in Web Worker)
    normalize,
    resampleN,
    strokesToSequence,
    dtw,
    dtwNorm,
    pointDist,

    // Dictionary operations
    save,
    match,
    remove,
    exportJSON,
    importJSON,
    list,
    count,
    isEmpty,

    DEFAULT_N
  };

})();

// Export to whatever global scope is active
(typeof window !== 'undefined' ? window : self).DTW = DTW;
