/* ═══════════════════════════════════════════════════════════════
   stroke-engine.js — Partial-stroke recognition state machine
   Exposed as: window.StrokeEngine (main thread)
               self.StrokeEngine  (Web Worker via importScripts)
   ───────────────────────────────────────────────────────────────
   DESIGN
   ──────
   The engine consumes RDP-simplified stroke points and converts
   them into a sequence of directional "segments" (run-length
   encoded compass directions). That sequence is then matched
   against a dictionary of character patterns.

   Matching happens at two levels:
     • Partial match  — current segments are a valid PREFIX of
                        a character's pattern. The character is
                        still "possible".
     • Complete match — current segments exactly equal a
                        character's full pattern.

   The prediction is updated:
     • In real-time DURING drawing (every few points) by
       calling updateLive(simplifiedInProgressStroke)
     • After each pen-lift via commitStroke(simplifiedStroke)
     • After a settle timeout via settle() — confirms the
       best complete match once the user pauses

   DIRECTION SYSTEM
   ────────────────
   Uses SCREEN coordinates (Y increases downward), so directions
   match visual intuition:
     SE = going right AND down
     NE = going right AND up
     S  = going straight down
   This differs from the existing stroke-processor.js direction
   labels (which use math-coord Y-up orientation); they are
   parallel systems that do not conflict.

   V vs W DISAMBIGUATION (the canonical demo)
   ──────────────────────────────────────────
   Drawing a continuous V-shape produces segments: [DOWN, UP]
     → complete: v
     → partial:  w (needs 2 more), n (needs 1 more), m (needs 3 more)
     → display:  [v / w? / n?]

   Third segment begins going DOWN: [DOWN, UP, DOWN]
     → v is ELIMINATED (exceeds its 2-seg pattern)
     → complete: n
     → partial:  w (needs 1 more), m (needs 2 more)
     → display:  [n / w? / m?]

   Fourth segment going UP: [DOWN, UP, DOWN, UP]
     → n is eliminated
     → complete: w
     → partial:  m (needs 1 more)
     → display:  [w / m?]

   Settle after pause → locks to: w
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const StrokeEngine = (() => {

  // ──────────────────────────────────────────────────────────────
  // Screen-coordinate direction quantisation
  // ──────────────────────────────────────────────────────────────

  // 8-compass labels in screen coords (Y-down), ordered by angle°
  // 0°=E, 45°=SE, 90°=S, 135°=SW, 180°=W, 225°=NW, 270°=N, 315°=NE
  const SCREEN_DIRS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];

  /**
   * Compass direction from point a to point b in screen coordinates.
   * @returns {string}  one of SCREEN_DIRS
   */
  function screenDir(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;   // positive = downward on screen
    const deg = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
    return SCREEN_DIRS[Math.round(deg / 45) % 8];
  }

  // ──────────────────────────────────────────────────────────────
  // Direction groups
  // ──────────────────────────────────────────────────────────────

  const GROUPS = {
    DOWN:  ['S', 'SE', 'SW'],
    UP:    ['N', 'NE', 'NW'],
    RIGHT: ['E', 'NE', 'SE'],
    LEFT:  ['W', 'NW', 'SW'],
    FLAT:  ['E', 'W'],
    VERT:  ['N', 'S'],
    DIAG_SE: ['SE'],
    DIAG_NE: ['NE'],
    DIAG_SW: ['SW'],
    DIAG_NW: ['NW'],
    ANY:   ['N','NE','E','SE','S','SW','W','NW']
  };

  // Pre-build Sets for O(1) lookup
  const GROUP_SETS = {};
  for (const [k, v] of Object.entries(GROUPS)) {
    GROUP_SETS[k] = new Set(v);
  }

  function dirMatchesGroup(dir, groupName) {
    const set = GROUP_SETS[groupName];
    return set ? set.has(dir) : dir === groupName; // exact match fallback
  }

  // ──────────────────────────────────────────────────────────────
  // Character pattern dictionary
  // ──────────────────────────────────────────────────────────────
  //
  // Each entry:
  //   char    — the recognised character
  //   label   — display string (may differ, e.g. for escape chars)
  //   segs    — ordered array of direction group names that
  //             each segment of the stroke must match
  //   note    — (optional) human-readable description
  //
  // Patterns should be ordered from SHORTEST to LONGEST so that
  // the "most specific" complete match wins ties during settling.

  const CHAR_PATTERNS = [
    // ── Single-segment (one direction) ────────────────────────

    { char: '/',   label: '/',   segs: ['UP'],   note: 'rising diagonal' },
    { char: '\\',  label: '\\',  segs: ['DOWN'], note: 'falling diagonal' },
    { char: '-',   label: '-',   segs: ['FLAT'], note: 'horizontal' },
    { char: '|',   label: '|',   segs: ['VERT'], note: 'vertical' },

    // ── Two-segment ───────────────────────────────────────────

    { char: 'v',   label: 'v',   segs: ['DOWN', 'UP'],   note: 'v-shape (down then up)' },
    { char: '^',   label: '^',   segs: ['UP',   'DOWN'], note: 'caret (up then down)' },
    { char: 'r',   label: 'r',   segs: ['DOWN', 'RIGHT'], note: 'partial r (down, hook right)' },
    { char: 'j',   label: 'j',   segs: ['DOWN', 'LEFT'],  note: 'j-hook (down, curl left)' },
    { char: 'L',   label: 'L',   segs: ['DOWN', 'RIGHT'], note: 'L shape' },

    // ── Three-segment ─────────────────────────────────────────

    { char: 'n',   label: 'n',   segs: ['DOWN', 'UP',    'DOWN'],  note: 'n arch' },
    { char: 'u',   label: 'u',   segs: ['DOWN', 'FLAT',  'UP'],    note: 'u (down, flat bottom, up)' },
    { char: 'z',   label: 'z',   segs: ['FLAT', 'DOWN',  'FLAT'],  note: 'z (flat, diagonal, flat)' },
    { char: 'Z',   label: 'Z',   segs: ['FLAT', 'DOWN',  'FLAT'],  note: 'Z (same shape as z)' },
    { char: 'c',   label: 'c',   segs: ['UP',   'LEFT',  'DOWN'],  note: 'c arc (up-left-down)' },
    { char: '7',   label: '7',   segs: ['FLAT', 'DOWN',  'LEFT'],  note: 'seven' },

    // ── Four-segment ──────────────────────────────────────────

    { char: 'w',   label: 'w',   segs: ['DOWN', 'UP',    'DOWN',  'UP'],   note: 'w (double-v)' },
    { char: 's',   label: 's',   segs: ['UP',   'LEFT',  'DOWN',  'RIGHT'], note: 's-curve' },
    { char: 'S',   label: 'S',   segs: ['UP',   'LEFT',  'DOWN',  'RIGHT'], note: 'S (same as s)' },

    // ── Five-segment ──────────────────────────────────────────

    { char: 'm',   label: 'm',   segs: ['DOWN', 'UP',    'DOWN',  'UP',   'DOWN'], note: 'm (triple arch)' },

    // ── Six-segment ───────────────────────────────────────────

    { char: 'M',   label: 'M',   segs: ['DOWN', 'UP',    'DOWN',  'UP',   'DOWN', 'UP'], note: 'M (very wide)' },
  ];

  // ──────────────────────────────────────────────────────────────
  // Segment extraction
  // ──────────────────────────────────────────────────────────────

  /**
   * Convert a simplified polyline into run-length-encoded directional
   * segments, filtering out tiny jitter segments.
   *
   * Algorithm:
   *   1. Compute direction and length for each consecutive point pair.
   *   2. Group consecutive same-direction pairs (run-length encode).
   *   3. Filter out segments shorter than `minFraction` of total length
   *      OR shorter than `minAbsPx` pixels.
   *   4. Re-merge adjacent same-direction segments after filtering.
   *
   * @param {Array<{x:number,y:number}>} pts         - RDP-simplified points
   * @param {number} [minFraction=0.09]               - relative min length
   * @param {number} [minAbsPx=6]                     - absolute min length px
   * @returns {Array<{dir:string, len:number}>}
   */
  function extractSegments(pts, minFraction = 0.09, minAbsPx = 6) {
    if (!pts || pts.length < 2) return [];

    // Step 1 — raw per-pair directions + lengths
    const raw = [];
    let totalLen = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.5) continue;
      raw.push({ dir: screenDir(pts[i - 1], pts[i]), len });
      totalLen += len;
    }
    if (raw.length === 0) return [];

    // Step 2 — run-length encode consecutive same-direction segments
    const grouped = [{ ...raw[0] }];
    for (let i = 1; i < raw.length; i++) {
      const last = grouped[grouped.length - 1];
      if (raw[i].dir === last.dir) {
        last.len += raw[i].len;
      } else {
        grouped.push({ ...raw[i] });
      }
    }

    // Step 3 — filter short segments
    const minLen = Math.max(minAbsPx, totalLen * minFraction);
    const filtered = grouped.filter(s => s.len >= minLen);
    if (filtered.length === 0) return grouped; // never return empty if input was valid

    // Step 4 — re-merge after filtering (adjacent same-dir may now be adjacent)
    const merged = [{ ...filtered[0] }];
    for (let i = 1; i < filtered.length; i++) {
      const last = merged[merged.length - 1];
      if (filtered[i].dir === last.dir) {
        last.len += filtered[i].len;
      } else {
        merged.push({ ...filtered[i] });
      }
    }

    return merged;
  }

  // ──────────────────────────────────────────────────────────────
  // Pattern matching
  // ──────────────────────────────────────────────────────────────

  /**
   * Match a segment sequence against the character dictionary.
   *
   * @param {Array<{dir:string,len:number}>} segments
   * @param {boolean} [settled=false]  - true when user has paused → pick
   *                                     best complete match and lock it
   * @returns {PredictionResult}
   */
  function matchPatterns(segments, settled = false) {
    if (!segments || segments.length === 0) {
      return {
        candidates: [],
        locked: false,
        display: '—',
        phase: 'empty',
        segments: []
      };
    }

    const fullMatches    = [];  // patterns where length === segs, all match
    const partialMatches = [];  // patterns where segs is a valid prefix

    for (const pat of CHAR_PATTERNS) {
      // If current sequence is LONGER than the pattern → eliminated
      if (segments.length > pat.segs.length) continue;

      // Check prefix match
      let ok = true;
      for (let i = 0; i < segments.length; i++) {
        if (!dirMatchesGroup(segments[i].dir, pat.segs[i])) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      if (segments.length === pat.segs.length) {
        fullMatches.push(pat);
      } else {
        partialMatches.push(pat);
      }
    }

    // ── De-duplicate by char ──
    // If same char appears as both full and partial, keep full status
    const charMap = new Map();
    for (const p of fullMatches) {
      charMap.set(p.char, { char: p.char, label: p.label, status: 'complete', note: p.note });
    }
    for (const p of partialMatches) {
      if (!charMap.has(p.char)) {
        charMap.set(p.char, { char: p.char, label: p.label, status: 'partial', note: p.note });
      }
    }
    const candidates = [...charMap.values()];

    const completeList = candidates.filter(c => c.status === 'complete');
    const partialList  = candidates.filter(c => c.status === 'partial');

    // ── Settle: user paused → commit the best complete match ──
    if (settled && completeList.length > 0) {
      // Pick shortest pattern (most specific complete match)
      const best = completeList[0];
      return {
        candidates,
        locked:  true,
        display: best.label,
        phase:   'locked',
        segments
      };
    }

    // ── Phase determination ──
    let display, phase, locked;

    if (candidates.length === 0) {
      // Nothing matches — unknown stroke
      display = '[?]';
      phase   = 'unknown';
      locked  = false;

    } else if (completeList.length === 1 && partialList.length === 0) {
      // Exactly one complete match, no longer possibilities → LOCKED
      display = completeList[0].label;
      phase   = 'locked';
      locked  = true;

    } else if (completeList.length === 0) {
      // Only partial matches — still building up
      const labels = partialList.slice(0, 3).map(c => c.label).join('/');
      display = `[${labels}…]`;
      phase   = 'partial';
      locked  = false;

    } else {
      // Mix of complete + partial  OR  multiple complete → ambiguous
      const completeLabels = completeList.map(c => c.label);
      const partialLabels  = partialList.slice(0, 2).map(c => c.label + '?');
      const all            = [...completeLabels, ...partialLabels];
      display = '[' + all.slice(0, 4).join(' / ') + ']';
      phase   = 'ambiguous';
      locked  = false;
    }

    return { candidates, locked, display, phase, segments };
  }

  // ──────────────────────────────────────────────────────────────
  // Engine state (main-thread stateful wrapper)
  // ──────────────────────────────────────────────────────────────

  let _committedStrokes  = [];   // simplified strokes completed so far in this cluster
  let _lastPrediction    = null;

  /**
   * Extract the flat segment sequence across all committed strokes
   * plus an optional live (in-progress) stroke.
   *
   * Stroke boundaries are transparent — segments from consecutive
   * strokes are concatenated. The matching logic interprets the
   * combined sequence as one gesture.
   */
  function _buildSegments(liveStroke) {
    const allSegs = [];
    for (const stroke of _committedStrokes) {
      allSegs.push(...extractSegments(stroke));
    }
    if (liveStroke && liveStroke.length >= 2) {
      allSegs.push(...extractSegments(liveStroke));
    }
    return allSegs;
  }

  /**
   * Update prediction with the current in-progress stroke (live).
   * Does NOT commit the stroke to history.
   *
   * @param {Array<{x,y}>} simplifiedLiveStroke
   * @returns {PredictionResult}
   */
  function updateLive(simplifiedLiveStroke) {
    const segs = _buildSegments(simplifiedLiveStroke);
    _lastPrediction = matchPatterns(segs, false);
    return _lastPrediction;
  }

  /**
   * Commit a completed stroke (pen-up) to the cluster history.
   *
   * @param {Array<{x,y}>} simplifiedStroke
   * @returns {PredictionResult}
   */
  function commitStroke(simplifiedStroke) {
    _committedStrokes.push(simplifiedStroke);
    const segs = _buildSegments(null);
    _lastPrediction = matchPatterns(segs, false);
    return _lastPrediction;
  }

  /**
   * Settle — user has paused; pick best complete match.
   * Call after TEMPORAL_GAP_MS without any drawing event.
   *
   * @returns {PredictionResult}
   */
  function settle() {
    const segs = _buildSegments(null);
    _lastPrediction = matchPatterns(segs, true);
    return _lastPrediction;
  }

  /**
   * Reset for a new spatial/temporal cluster.
   * Called when the user's next stroke starts far from the last one.
   */
  function newCluster() {
    _committedStrokes = [];
    _lastPrediction   = null;
  }

  /**
   * Full reset — clear canvas was pressed.
   */
  function reset() {
    _committedStrokes = [];
    _lastPrediction   = null;
  }

  // ──────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────

  const api = {
    // Pure functions (also used by worker)
    screenDir,
    extractSegments,
    matchPatterns,

    // Stateful engine
    updateLive,
    commitStroke,
    settle,
    newCluster,
    reset,

    get lastPrediction() { return _lastPrediction; },
    get committedCount()  { return _committedStrokes.length; }
  };

  return api;

})();

// Export to whatever global scope is active:
//   • main thread  → window.StrokeEngine
//   • Web Worker   → self.StrokeEngine  (via importScripts)
(typeof window !== 'undefined' ? window : self).StrokeEngine = StrokeEngine;
