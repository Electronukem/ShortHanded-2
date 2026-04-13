/* ═══════════════════════════════════════════════════════════════
   calibration.js — Personalized Baseline Calibration
   Exposed as: window.CalibrationManager
   ───────────────────────────────────────────────────────────────
   PIPELINE
   ────────
   User draws a–z  →  storeLetter()  →  _profile[letter].raw/sequence
                                              │
                                      analyzeShortcuts()
                                              │
                          for each letter: truncate raw points at
                          30/40/50/60/70/80/90% of arc-length,
                          re-normalize, resample to N=32, DTW vs
                          all other 25 full templates  →  find
                          minimum % where letter stays unique
                                              │
                                      _shortcuts[letter] = { pct }
                                              │
                          matchPartial()  ←  live drawing loop
                          (returns best letter or null)

   SHORTCUT DISCOVERY MATH
   ───────────────────────
   For letter L:
     1. Try keeping pct ∈ {30%, 40%, …, 90%} of raw stroke points
     2. partial = rawPts.slice(0, floor(rawPts.length × pct))
     3. Re-normalize partial to its own bounding box
     4. Arc-length resample to N=32 points
     5. DTW(partial, L_full)  — "self distance"
     6. For every other letter O: DTW(partial, O_full)
        If ANY otherDist ≤ selfDist → not unique at this pct
     7. Find minimum pct where L is still uniquely closest to itself
        → that is the shortcut threshold for L

   LIVE MATCHING
   ─────────────
   On every throttled pointermove (4 pts), the current partial
   stroke is normalized and compared against ALL 26 calibrated
   templates.  A shortcut fires when:
     • Best matching template has a recorded shortcut
     • DTW distance < CONF_THRESHOLD (0.25)
     • Second-closest is ≥ GAP_RATIO (1.30×) farther

   PERSISTENCE
   ───────────
   Full profile + shortcuts stored in localStorage under
   'shorthanded_calibration_v1'.  Each storeLetter() call
   persists immediately so partial profiles survive page reload.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const CalibrationManager = (() => {

  const ALPHABET    = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const STORAGE_KEY = 'shorthanded_calibration_v1';
  const N           = 32;   // sequence length (matches DTW.DEFAULT_N)
  // Percentages of stroke to KEEP, ordered smallest → largest.
  // Analysis iterates this order and stops at the first pct that is
  // still uniquely identifiable — giving the minimum threshold.
  const KEEP_PCTS   = [0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90];

  // Confidence / uniqueness parameters for live matching
  const CONF_THRESHOLD = 0.25;   // max DTW dist to trigger a shortcut
  const GAP_RATIO      = 1.30;   // second-best must be this much farther

  // ──────────────────────────────────────────────────────────────
  // Internal state
  // ──────────────────────────────────────────────────────────────

  // _profile[letter] = {
  //   raw:      Array<{x,y}>   — flat simplified points (for analysis)
  //   sequence: Array<{x,y}>   — normalized + resampled N pts (for DTW)
  // }
  let _profile  = {};

  // _shortcuts[letter] = { pct: number }
  // Only letters where pct < 1.0 are stored here.
  let _shortcuts = {};

  // ──────────────────────────────────────────────────────────────
  // Persistence
  // ──────────────────────────────────────────────────────────────

  function _save() {
    try {
      const data = { version: 1, profile: {}, shortcuts: _shortcuts };
      for (const [letter, entry] of Object.entries(_profile)) {
        data.profile[letter] = {
          raw:      entry.raw,
          sequence: entry.sequence
        };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[Cal] localStorage save failed:', e.message);
    }
  }

  function _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      _shortcuts = data.shortcuts || {};
      for (const [letter, entry] of Object.entries(data.profile || {})) {
        _profile[letter] = {
          raw:      entry.raw.map(p => ({ x: p.x, y: p.y })),
          sequence: entry.sequence.map(p => ({ x: p.x, y: p.y }))
        };
      }
    } catch (e) {
      console.warn('[Cal] localStorage load failed:', e.message);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Profile capture
  // ──────────────────────────────────────────────────────────────

  /**
   * Store the calibration sample for one letter.
   * Called from app.js when the user clicks "Accept" on a letter.
   *
   * @param {string} letter                              - 'a'–'z'
   * @param {Array<Array<{x:number,y:number}>>} simplifiedStrokes
   *        RDP-simplified strokes from the canvas (may be multi-stroke)
   * @returns {boolean} true if stored successfully
   */
  function storeLetter(letter, simplifiedStrokes) {
    // Flatten all strokes into one ordered point sequence
    const flat = [];
    for (const stroke of simplifiedStrokes) {
      for (const pt of stroke) flat.push({ x: pt.x, y: pt.y });
    }
    if (flat.length < 2) return false;

    const sequence = DTW.resampleN(DTW.normalize(flat), N);
    _profile[letter] = { raw: flat, sequence };
    _save();   // persist immediately so progress survives reload
    return true;
  }

  // ──────────────────────────────────────────────────────────────
  // Shortcut analysis
  // ──────────────────────────────────────────────────────────────

  /**
   * Analyse the stored baseline profile and discover shortcuts.
   *
   * For each letter, find the minimum percentage of its stroke that
   * uniquely identifies it against every other calibrated letter.
   *
   * Runs synchronously (typically < 100 ms for 26 × 7 × 25 DTW ops
   * with N=32).
   *
   * @returns {Object}  _shortcuts — { letter: { pct } }
   */
  function analyzeShortcuts() {
    _shortcuts = {};
    const letters = ALPHABET.filter(l => _profile[l]);
    if (letters.length < 2) return _shortcuts;

    for (const letter of letters) {
      const { raw: rawPts, sequence: fullSeq } = _profile[letter];

      let shortcutPct = null;  // smallest pct that is still uniquely identifiable

      // Iterate from smallest to largest — stop at first unique threshold
      for (const pct of KEEP_PCTS) {
        const keepCount = Math.max(2, Math.floor(rawPts.length * pct));
        const partialRaw = rawPts.slice(0, keepCount);

        // Re-normalise partial to its own bounding box (simulates live partial)
        const partialSeq = DTW.resampleN(DTW.normalize(partialRaw), N);

        // Self-distance: how close is the partial to the letter's full template
        const selfDist = DTW.dtwNorm(partialSeq, fullSeq);

        // Check uniqueness: partial must be closer to itself than to every other letter
        let isUnique = true;
        for (const other of letters) {
          if (other === letter) continue;
          const otherDist = DTW.dtwNorm(partialSeq, _profile[other].sequence);
          if (otherDist <= selfDist) {
            isUnique = false;
            break;
          }
        }

        if (isUnique) {
          shortcutPct = pct;
          break;  // found minimum — stop searching
        }
      }

      if (shortcutPct !== null) {
        // Only record letters that don't need 100% of the stroke
        _shortcuts[letter] = { pct: shortcutPct };
      }
    }

    _save();
    return _shortcuts;
  }

  // ──────────────────────────────────────────────────────────────
  // Live partial matching
  // ──────────────────────────────────────────────────────────────

  /**
   * Compare the current in-progress stroke against calibrated templates.
   * Call this from the live drawing loop.
   *
   * Returns a match if:
   *   • The closest template is a shortcutted letter
   *   • DTW distance is below CONF_THRESHOLD
   *   • The second-closest is ≥ GAP_RATIO × farther (unique enough)
   *
   * @param {Array<Array<{x:number,y:number}>>} simplifiedStrokes
   *        All simplified stroke arrays in the current cluster
   *        (committed + in-progress live stroke)
   * @returns {{ letter: string, distance: number, pct: number } | null}
   */
  function matchPartial(simplifiedStrokes) {
    const allLetters = ALPHABET.filter(l => _profile[l]);
    if (allLetters.length < 2 || Object.keys(_shortcuts).length === 0) return null;

    // Flatten all strokes
    const flat = [];
    for (const stroke of simplifiedStrokes) {
      for (const pt of stroke) flat.push({ x: pt.x, y: pt.y });
    }
    if (flat.length < 3) return null;

    const partial = DTW.resampleN(DTW.normalize(flat), N);

    // DTW distance to every calibrated letter
    const distances = {};
    for (const l of allLetters) {
      distances[l] = DTW.dtwNorm(partial, _profile[l].sequence);
    }

    // Sort by ascending distance
    const sorted = allLetters.slice().sort((a, b) => distances[a] - distances[b]);
    const best   = sorted[0];
    const second = sorted[1];

    // Gate 1: must be a shortcutted letter
    if (!_shortcuts[best]) return null;

    // Gate 2: confidence threshold
    if (distances[best] > CONF_THRESHOLD) return null;

    // Gate 3: uniqueness gap
    if (second && distances[second] < distances[best] * GAP_RATIO) return null;

    return {
      letter:   best,
      distance: distances[best],
      pct:      _shortcuts[best].pct
    };
  }

  // ──────────────────────────────────────────────────────────────
  // State queries
  // ──────────────────────────────────────────────────────────────

  /** True if all 26 letters have been calibrated. */
  function hasProfile() {
    return ALPHABET.every(l => _profile[l]);
  }

  /** Number of letters captured so far. */
  function profileLetterCount() {
    return ALPHABET.filter(l => _profile[l]).length;
  }

  /** True if shortcut analysis has been run and found at least one shortcut. */
  function hasShortcuts() { return Object.keys(_shortcuts).length > 0; }

  /** The discovered shortcuts map. */
  function getShortcuts() { return _shortcuts; }

  /** The full profile map (raw + sequence per letter). */
  function getProfile() { return _profile; }

  /** Wipe all calibration data (profile + shortcuts) from memory and storage. */
  function clearAll() {
    _profile   = {};
    _shortcuts = {};
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  // ── Auto-load on module evaluation ──
  _load();

  // ──────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────
  return {
    ALPHABET,
    storeLetter,
    analyzeShortcuts,
    matchPartial,
    clearAll,
    hasProfile,
    profileLetterCount,
    hasShortcuts,
    getShortcuts,
    getProfile
  };

})();

(typeof window !== 'undefined' ? window : self).CalibrationManager = CalibrationManager;
