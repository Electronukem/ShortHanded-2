/* ═══════════════════════════════════════════════════════════════
   app.js — Shorthanded main controller
   ───────────────────────────────────────────────────────────────
   Owns:
     • Canvas setup and resize handling
     • Pointer event capture (draw canvas)
     • Real-time RDP + cluster overlay rendering
     • Event-driven pipeline: draw → RDP → features → OCR
     • UI bindings (toolbar, status bar, panels)
     • Logger (window.Logger — used by all modules)
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ──────────────────────────────────────────────────────────────
// Logger (must be defined FIRST — other modules call it)
// ──────────────────────────────────────────────────────────────

window.Logger = (() => {
  const logEl = () => document.getElementById('log-output');
  const MAX_ENTRIES = 200;

  function log(tag, msg) {
    const container = logEl();
    if (!container) { console.log(`[${tag}] ${msg}`); return; }

    const now = new Date();
    const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;

    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML =
      `<span class="log-time">${time}</span>` +
      `<span class="log-tag ${tag}">[${tag}]</span>` +
      `<span class="log-msg">${escapeHtml(String(msg))}</span>`;

    container.appendChild(entry);

    // Trim overflow
    while (container.children.length > MAX_ENTRIES) {
      container.removeChild(container.firstChild);
    }

    container.scrollTop = container.scrollHeight;
  }

  function clear() {
    const el = logEl();
    if (el) el.innerHTML = '';
  }

  function escapeHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { log, clear };
})();

// ──────────────────────────────────────────────────────────────
// Application state
// ──────────────────────────────────────────────────────────────

const App = (() => {

  // Canvas layers
  let drawCtx, rdpCtx, clusterCtx;

  // Stroke data
  let rawStrokes   = [];   // Array of Array<{x,y,t,pressure}>
  let currentStroke = null; // Active stroke being drawn
  let isDrawing = false;

  // Settings (kept in sync with toolbar controls)
  let settings = {
    rdpEpsilon:   3,
    penSize:      3,
    showRDP:      true,
    useSmoothing: false,
    dtwThreshold: 0.25
  };

  // ── Calibration state ──
  let _calibrationMode  = false;   // true while alphabet calibration is active
  let _calibCurrentIdx  = 0;       // 0–25 (index into CalibrationManager.ALPHABET)
  let _shortcutMatch    = null;    // last live shortcut match result (or null)

  // Pipeline debounce
  let pipelineTimer = null;
  const PIPELINE_DEBOUNCE_MS = 250;

  // Prediction settle timer — fires after inactivity to lock best guess
  let settleTimer = null;
  const SETTLE_MS = 650;

  // Prediction update throttle counter
  let _predThrottle = 0;
  const PRED_EVERY_N_POINTS = 4;   // update prediction every 4 captured points

  // Last computed payload (for export)
  let lastPayload = null;

  // ──────────────────────────────────────────────────────────────
  // Initialisation
  // ──────────────────────────────────────────────────────────────

  function init() {
    Logger.log('info', 'Shorthanded initialising…');

    _setupCanvases();
    _setupToolbar();
    _setupPointerEvents();
    _setupPanelButtons();

    // Boot OCR service (with worker prediction callback)
    OCRService.init(
      (msg, pct) => { setOCRStatus('working'); },
      (prediction) => {
        // Worker cross-check prediction arrives here (async, after stroke commit)
        Logger.log('predict', `[worker] ${prediction.display} (${prediction.phase})`);
      }
    );

    // Resize handler
    window.addEventListener('resize', _onResize);
    _onResize();

    // Render dictionary panel (may already have saved templates from localStorage)
    _renderDictPanel();
    if (!DTW.isEmpty()) {
      Logger.log('dtw', `Loaded ${DTW.count()} template(s) from localStorage.`);
    }

    // Restore calibration shortcuts from localStorage if they exist
    if (CalibrationManager.hasShortcuts()) {
      _renderShortcutBox(CalibrationManager.getShortcuts());
      Logger.log('calib',
        `Loaded calibration profile (${CalibrationManager.profileLetterCount()} letters, ` +
        `${Object.keys(CalibrationManager.getShortcuts()).length} shortcuts).`
      );
    }

    Logger.log('info', 'Ready. Draw something!');
  }

  // ──────────────────────────────────────────────────────────────
  // Canvas setup
  // ──────────────────────────────────────────────────────────────

  function _setupCanvases() {
    drawCtx    = document.getElementById('draw-canvas').getContext('2d');
    rdpCtx     = document.getElementById('rdp-canvas').getContext('2d');
    clusterCtx = document.getElementById('cluster-canvas').getContext('2d');
  }

  function _onResize() {
    const wrapper = document.getElementById('canvas-wrapper');
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;

    ['draw-canvas','rdp-canvas','cluster-canvas'].forEach(id => {
      const c = document.getElementById(id);
      // Preserve drawing on resize by copying to temp canvas
      const tmp = document.createElement('canvas');
      tmp.width = c.width; tmp.height = c.height;
      tmp.getContext('2d').drawImage(c, 0, 0);
      c.width  = w;
      c.height = h;
      if (id === 'draw-canvas') {
        drawCtx.drawImage(tmp, 0, 0);
      }
    });

    _redrawRDPOverlay();
    _redrawClusterOverlay();
  }

  // ──────────────────────────────────────────────────────────────
  // Pointer events — smooth pressure-aware capture
  // ──────────────────────────────────────────────────────────────

  function _setupPointerEvents() {
    const canvas = document.getElementById('draw-canvas');

    canvas.addEventListener('pointerdown', _onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', _onPointerMove, { passive: false });
    canvas.addEventListener('pointerup',   _onPointerUp,   { passive: false });
    canvas.addEventListener('pointerleave',_onPointerUp,   { passive: false });
    canvas.addEventListener('pointercancel',_onPointerUp,  { passive: false });
    // Prevent default touch scrolling on mobile
    canvas.addEventListener('touchstart',  e => e.preventDefault(), { passive: false });
  }

  function _getPoint(e) {
    const rect = document.getElementById('draw-canvas').getBoundingClientRect();
    return {
      x:        e.clientX - rect.left,
      y:        e.clientY - rect.top,
      t:        e.timeStamp,
      pressure: e.pressure > 0 ? +e.pressure.toFixed(3) : null
    };
  }

  function _onPointerDown(e) {
    e.preventDefault();
    if (e.button !== 0 && e.pointerType !== 'pen' && e.pointerType !== 'touch') return;
    document.getElementById('draw-canvas').setPointerCapture(e.pointerId);

    // ── Cluster boundary detection ──
    // If the new stroke starts far (spatial) or late (temporal) from
    // the last stroke, this is a new word — reset the engine cluster.
    if (rawStrokes.length > 0) {
      const lastStroke = rawStrokes[rawStrokes.length - 1];
      const lastPt     = lastStroke[lastStroke.length - 1];
      const newPt      = { x: e.clientX - document.getElementById('draw-canvas').getBoundingClientRect().left,
                           y: e.clientY - document.getElementById('draw-canvas').getBoundingClientRect().top };
      const spatialGap  = GeoUtils.dist(lastPt, newPt);
      const temporalGap = e.timeStamp - (lastPt.t || 0);

      if (spatialGap  > StrokeProcessor.SPATIAL_GAP_PX ||
          temporalGap > StrokeProcessor.TEMPORAL_GAP_MS) {
        StrokeEngine.newCluster();
        Logger.log('predict', `New cluster detected (Δ${spatialGap.toFixed(0)}px / ${temporalGap.toFixed(0)}ms)`);
      }
    }

    // Cancel any pending settle — user is drawing again
    clearTimeout(settleTimer);
    settleTimer = null;
    _predThrottle = 0;

    isDrawing = true;
    currentStroke = [_getPoint(e)];

    // Start drawing
    drawCtx.lineCap     = 'round';
    drawCtx.lineJoin    = 'round';
    drawCtx.lineWidth   = settings.penSize;
    drawCtx.strokeStyle = '#e0e8ff';
    drawCtx.beginPath();
    const pt = currentStroke[0];
    drawCtx.moveTo(pt.x, pt.y);
  }

  function _onPointerMove(e) {
    if (!isDrawing || !currentStroke) return;
    e.preventDefault();

    const pt = _getPoint(e);
    currentStroke.push(pt);

    // Live draw
    drawCtx.lineTo(pt.x, pt.y);
    drawCtx.stroke();
    drawCtx.beginPath();
    drawCtx.moveTo(pt.x, pt.y);

    // Real-time RDP overlay + prediction update (throttled)
    _predThrottle++;
    if (_predThrottle >= PRED_EVERY_N_POINTS) {
      _predThrottle = 0;
      _updateRDPOverlay();
      _updateLivePrediction();
    }
  }

  function _onPointerUp(e) {
    if (!isDrawing || !currentStroke) return;
    isDrawing = false;

    if (currentStroke.length > 0) {
      rawStrokes.push(currentStroke);
      Logger.log('stroke', `Stroke #${rawStrokes.length} ended — ${currentStroke.length} raw pts`);

      // ── During calibration: skip OCR/DTW/settle — just draw ──
      if (_calibrationMode) {
        currentStroke = null;
        _updateStatusBar();
        _redrawRDPOverlay();
        return;
      }

      // ── Commit stroke to prediction engine ──
      const simplified = RDP.simplify(currentStroke, settings.rdpEpsilon);
      if (simplified.length >= 2) {
        const prediction = StrokeEngine.commitStroke(simplified);
        _renderPredictionBox(prediction);
        Logger.log('predict',
          `Committed stroke #${rawStrokes.length}: ${prediction.display} [${prediction.phase}]`);

        // Fire worker cross-check (async, non-blocking)
        const allSimplified = rawStrokes.map(s => RDP.simplify(s, settings.rdpEpsilon));
        OCRService.predict(allSimplified, false).catch(() => {});
      }
    }
    currentStroke = null;

    if (_calibrationMode) return;   // already returned above if stroke was non-empty

    // ── DTW template matching ──
    // Run immediately on each stroke commit — fast enough (<1 ms for
    // typical dictionary sizes) to stay on the main thread.
    if (!DTW.isEmpty()) {
      const allSimp = rawStrokes.map(s => RDP.simplify(s, settings.rdpEpsilon));
      _runDTWMatch(allSimp);
    }

    // ── Schedule settle timer ──
    // After SETTLE_MS of inactivity, lock to best complete match
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const settled = StrokeEngine.settle();
      _renderPredictionBox(settled);
      Logger.log('predict', `Settled → ${settled.display}`);
      // Re-run DTW on settled state for final confirmation log
      if (!DTW.isEmpty()) {
        const allSimp = rawStrokes.map(s => RDP.simplify(s, settings.rdpEpsilon));
        _runDTWMatch(allSimp, true);
      }
      settleTimer = null;
    }, SETTLE_MS);

    _updateStatusBar();
    _redrawRDPOverlay();
    _redrawClusterOverlay();
    _schedulePipeline();
  }

  // ──────────────────────────────────────────────────────────────
  // RDP overlay rendering
  // ──────────────────────────────────────────────────────────────

  function _updateRDPOverlay() {
    if (!settings.showRDP || !currentStroke) return;
    // Simplified version of the in-progress stroke
    const simplified = RDP.simplify(currentStroke, settings.rdpEpsilon);
    if (simplified.length < 2) return;

    const canvas = document.getElementById('rdp-canvas');
    const ctx    = rdpCtx;

    // Clear only the area around the stroke for performance
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw full history first, then current
    _drawAllRDPStrokes(ctx);

    // Current in-progress stroke
    ctx.strokeStyle = '#f5a623';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([4, 3]);
    GeoUtils.drawPolyline(ctx, simplified);
    ctx.setLineDash([]);

    // Dot markers on kept points
    ctx.fillStyle = '#f5a623';
    GeoUtils.drawDots(ctx, simplified, 2.5);
  }

  function _redrawRDPOverlay() {
    if (!settings.showRDP) {
      rdpCtx.clearRect(0, 0,
        document.getElementById('rdp-canvas').width,
        document.getElementById('rdp-canvas').height);
      return;
    }
    const canvas = document.getElementById('rdp-canvas');
    rdpCtx.clearRect(0, 0, canvas.width, canvas.height);
    _drawAllRDPStrokes(rdpCtx);
  }

  function _drawAllRDPStrokes(ctx) {
    const canvas = document.getElementById('rdp-canvas');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const stroke of rawStrokes) {
      const simplified = RDP.simplify(stroke, settings.rdpEpsilon);
      if (simplified.length < 2) continue;

      // Draw simplified path
      ctx.strokeStyle = '#f5a623';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4, 3]);
      GeoUtils.drawPolyline(ctx, simplified);
      ctx.setLineDash([]);

      // Dots at RDP-kept vertices
      ctx.fillStyle = '#f5a623';
      GeoUtils.drawDots(ctx, simplified, 2.5);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Live prediction
  // ──────────────────────────────────────────────────────────────

  /**
   * Called during pointermove (throttled). Simplifies the in-progress
   * stroke and feeds it to StrokeEngine for an instant prediction.
   * Also checks calibration shortcuts for early letter identification.
   */
  function _updateLivePrediction() {
    if (!currentStroke || currentStroke.length < 2) return;
    const simplified = RDP.simplify(currentStroke, settings.rdpEpsilon);
    if (simplified.length < 2) return;

    // ── Calibration shortcut check (highest priority) ──
    if (CalibrationManager.hasShortcuts()) {
      // Build full stroke context: all committed strokes + live stroke
      const allSimplified = [
        ...rawStrokes.map(s => RDP.simplify(s, settings.rdpEpsilon)),
        simplified
      ];
      const match = CalibrationManager.matchPartial(allSimplified);

      if (match) {
        // Only update if this is a new/different match to avoid flicker
        const prev = _shortcutMatch;
        if (!prev || prev.letter !== match.letter) {
          _shortcutMatch = match;
          _renderShortcutLiveMatch(match);
          Logger.log('calib',
            `Shortcut fired: '${match.letter}' at dist=${match.distance.toFixed(3)} ` +
            `(threshold ${Math.round(match.pct * 100)}%)`
          );
        }
        // Emit as a locked prediction
        _renderPredictionBox({
          candidates: [{ char: match.letter, label: match.letter, status: 'complete' }],
          locked:  true,
          display: match.letter,
          phase:   'locked',
          segments: []
        });
        return;
      } else if (_shortcutMatch) {
        // Match dropped — clear live indicator
        _shortcutMatch = null;
        _clearShortcutLiveMatch();
      }
    }

    // ── Regular segment-based prediction ──
    const prediction = StrokeEngine.updateLive(simplified);
    _renderPredictionBox(prediction);
  }

  /**
   * Update the prediction bar DOM to reflect the latest PredictionResult.
   * @param {PredictionResult|null} prediction
   */
  function _renderPredictionBox(prediction) {
    const bar         = document.getElementById('prediction-bar');
    const display     = document.getElementById('prediction-display');
    const phaseTag    = document.getElementById('prediction-phase-tag');
    const candEl      = document.getElementById('prediction-candidates-live');
    const segEl       = document.getElementById('prediction-segments-display');

    if (!prediction || prediction.phase === 'empty') {
      bar.className     = 'phase-empty';
      display.className = 'phase-empty';
      display.textContent = '—';
      phaseTag.textContent = '';
      candEl.innerHTML  = '';
      segEl.innerHTML   = '';
      return;
    }

    const phase = prediction.phase;
    const wasLocked = display.classList.contains('phase-locked');

    // ── Bar + display phase class ──
    bar.className     = `phase-${phase}`;
    display.className = `phase-${phase}`;
    display.textContent = prediction.display;

    // Pop animation on lock
    if (phase === 'locked' && !wasLocked) {
      display.classList.add('just-locked');
      display.addEventListener('animationend', () => display.classList.remove('just-locked'), { once: true });
    }

    // ── Phase tag ──
    const PHASE_LABELS = {
      locked:    'Confirmed',
      ambiguous: 'Ambiguous',
      partial:   'Drawing…',
      unknown:   'Unrecognised',
      empty:     ''
    };
    phaseTag.textContent = PHASE_LABELS[phase] || phase;

    // ── Candidate chips ──
    candEl.innerHTML = '';
    for (const c of (prediction.candidates || [])) {
      const chip = document.createElement('span');
      chip.className   = `pred-chip ${c.status}`;
      chip.title       = c.note || c.char;
      chip.textContent = c.label + (c.status === 'partial' ? '…' : '');
      candEl.appendChild(chip);
    }

    // ── Segment pills ──
    segEl.innerHTML = '';

    // Group each raw direction into its visual category for colouring
    const DOWN_DIRS = new Set(['S','SE','SW']);
    const UP_DIRS   = new Set(['N','NE','NW']);

    for (const seg of (prediction.segments || [])) {
      const pill = document.createElement('span');
      const category = DOWN_DIRS.has(seg.dir) ? 'DOWN'
                      : UP_DIRS.has(seg.dir)   ? 'UP'
                      : seg.dir;
      pill.className   = `seg-pill ${category}`;
      pill.title       = `${seg.dir} (${seg.len.toFixed(0)}px)`;
      pill.textContent = seg.dir;
      segEl.appendChild(pill);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // DTW matching
  // ──────────────────────────────────────────────────────────────

  /**
   * Run DTW against all saved templates and update the match row
   * in the prediction bar plus the dictionary panel scores.
   *
   * @param {Array<Array<{x,y}>>} simplifiedStrokes
   * @param {boolean} [settled=false]  - true when called from settle timer
   */
  function _runDTWMatch(simplifiedStrokes, settled = false) {
    const results = DTW.match(simplifiedStrokes, settings.dtwThreshold);
    if (results.length === 0) return;

    const best = results[0];

    // ── Log top results ──
    const tag = settled ? 'dtw' : 'dtw';
    Logger.log(tag,
      `Best: "${best.text}" dist=${best.distance.toFixed(4)}` +
      (best.matched ? ' ✓ MATCH' : ' (no match)') +
      ` | threshold=${settings.dtwThreshold}`
    );
    // Log top-3
    results.slice(0, 3).forEach((r, i) => {
      if (i === 0) return; // already logged above
      Logger.log('info', `  #${i + 1} "${r.text}" dist=${r.distance.toFixed(4)}`);
    });

    // ── Update match row display ──
    _renderDTWMatchRow(best, results);

    // ── If matched, push text into the OCR result panel ──
    if (best.matched) {
      document.getElementById('ocr-result').textContent = best.text;
      setOCRStatus('done');
    }

    // ── Update per-entry distance badges in the dictionary panel ──
    _updateDictDistances(results);
  }

  /**
   * Render the DTW match row inside the prediction bar.
   * @param {{ text, distance, matched }} best
   * @param {MatchResult[]} allResults
   */
  function _renderDTWMatchRow(best, allResults) {
    const row      = document.getElementById('dtw-match-row');
    const textEl   = document.getElementById('dtw-match-text');
    const barsEl   = document.getElementById('dtw-match-bars');
    const distEl   = document.getElementById('dtw-match-dist');

    row.classList.remove('dtw-hidden', 'dtw-hit', 'dtw-miss');
    row.classList.add(best.matched ? 'dtw-hit' : 'dtw-miss');

    textEl.textContent = best.matched ? best.text : `no match (best: "${best.text}")`;
    distEl.textContent = `dist ${best.distance.toFixed(3)}`;

    // Confidence bars: 5 bars, green filled proportional to (1 - dist/threshold)
    barsEl.innerHTML = '';
    const confidence = Math.max(0, Math.min(1, 1 - best.distance / settings.dtwThreshold));
    const filledBars = Math.round(confidence * 5);
    for (let i = 0; i < 5; i++) {
      const bar = document.createElement('span');
      bar.className = 'dtw-bar' + (i < filledBars ? ' filled' : '');
      barsEl.appendChild(bar);
    }
  }

  /**
   * Render the Shorthand Dictionary panel — full list of templates.
   * Called on init and whenever the dictionary changes.
   */
  function _renderDictPanel() {
    const listEl  = document.getElementById('dict-list');
    const emptyEl = document.getElementById('dict-empty-msg');
    const countEl = document.getElementById('dtw-count-badge');

    const entries = DTW.list();
    const n       = entries.length;

    countEl.textContent = `${n} template${n !== 1 ? 's' : ''}`;

    if (n === 0) {
      if (emptyEl) emptyEl.style.display = '';
      // Remove all entry rows
      listEl.querySelectorAll('.dict-entry').forEach(el => el.remove());
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    // Re-render all entries
    listEl.querySelectorAll('.dict-entry').forEach(el => el.remove());

    for (const entry of entries) {
      const row = document.createElement('div');
      row.className    = 'dict-entry';
      row.dataset.id   = entry.id;

      const date = new Date(entry.timestamp);
      const dateStr = `${date.getMonth()+1}/${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;

      row.innerHTML =
        `<div class="dict-entry-text" title="${_escHtml(entry.text)}">${_escHtml(entry.text)}</div>` +
        `<div class="dict-entry-meta">` +
          `<span class="dict-entry-strokes">${entry.strokeCount} stroke${entry.strokeCount !== 1 ? 's' : ''} · ${dateStr}</span>` +
          `<span class="dict-entry-dist dist-hidden" data-id="${entry.id}">—</span>` +
        `</div>` +
        `<button class="dict-entry-del" data-id="${entry.id}" title="Delete template">✕</button>`;

      row.querySelector('.dict-entry-del').addEventListener('click', (e) => {
        const id = +e.currentTarget.dataset.id;
        DTW.remove(id);
        Logger.log('info', `Template #${id} deleted.`);
        _renderDictPanel();
        document.getElementById('dtw-match-row').classList.add('dtw-hidden');
      });

      listEl.appendChild(row);
    }
  }

  /**
   * Update just the distance badges on existing dict entries
   * without a full re-render — called after every DTW run.
   * @param {MatchResult[]} results
   */
  function _updateDictDistances(results) {
    // Clear best-match highlight from all entries
    document.querySelectorAll('.dict-entry').forEach(el => {
      el.classList.remove('dtw-best-match');
    });

    for (const r of results) {
      const distEl = document.querySelector(`.dict-entry-dist[data-id="${r.id}"]`);
      const rowEl  = document.querySelector(`.dict-entry[data-id="${r.id}"]`);
      if (!distEl) continue;

      distEl.classList.remove('dist-hidden', 'dist-good', 'dist-ok', 'dist-poor');
      distEl.textContent = r.distance.toFixed(3);

      if (r.distance <= settings.dtwThreshold) {
        distEl.classList.add('dist-good');
        if (rowEl) rowEl.classList.add('dtw-best-match');
      } else if (r.distance <= settings.dtwThreshold * 1.5) {
        distEl.classList.add('dist-ok');
      } else {
        distEl.classList.add('dist-poor');
      }
    }
  }

  /** HTML-escape a string for safe insertion. */
  function _escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ──────────────────────────────────────────────────────────────
  // Cluster overlay rendering
  // ──────────────────────────────────────────────────────────────

  function _redrawClusterOverlay() {
    const canvas = document.getElementById('cluster-canvas');
    clusterCtx.clearRect(0, 0, canvas.width, canvas.height);

    if (!lastPayload) return;

    clusterCtx.strokeStyle = '#3ecf8e';
    clusterCtx.lineWidth   = 1;
    clusterCtx.setLineDash([3, 3]);
    clusterCtx.font        = '10px monospace';
    clusterCtx.fillStyle   = '#3ecf8e';

    for (const cluster of lastPayload.clusters) {
      const bb = cluster.boundingBox;
      GeoUtils.drawBBox(clusterCtx, bb, 6);
      clusterCtx.fillText(`C${cluster.index}`, bb.x - 6, bb.y - 10);
    }
    clusterCtx.setLineDash([]);
  }

  // ──────────────────────────────────────────────────────────────
  // Pipeline — debounced after each stroke lift
  // ──────────────────────────────────────────────────────────────

  function _schedulePipeline() {
    clearTimeout(pipelineTimer);
    pipelineTimer = setTimeout(_runPipeline, PIPELINE_DEBOUNCE_MS);
  }

  async function _runPipeline() {
    if (rawStrokes.length === 0) return;

    Logger.log('rdp', `Running pipeline on ${rawStrokes.length} strokes, ε=${settings.rdpEpsilon}`);

    // 1. Build full ShorthandPayload
    const payload = StrokeProcessor.buildPayload(
      rawStrokes,
      settings.rdpEpsilon,
      settings.useSmoothing
    );
    lastPayload = payload;

    // 2. Update status bar
    _updateStatusBar();

    // 3. Render cluster overlay
    _redrawClusterOverlay();

    // 4. Render payload in panel
    _renderPayloadPanel(payload);

    // 5. Log stats
    Logger.log('rdp',
      `ε=${settings.rdpEpsilon} → ${payload.stats.rawPointCount} → ${payload.stats.simplifiedPointCount} pts ` +
      `(${payload.stats.reductionPercent}% reduction, ${payload.stats.compressionRatio}× ratio)`
    );
    Logger.log('cluster',
      `${payload.stats.clusterCount} cluster(s) from ${payload.stats.strokeCount} strokes`
    );

    // 6. Send to OCR service
    setOCRStatus('working');
    try {
      const result = await OCRService.process(payload);
      _renderOCRResult(result);
      setOCRStatus('done');
      Logger.log('ocr',
        `Result: "${result.text}" (conf=${result.confidence})`
      );
    } catch (err) {
      setOCRStatus('error');
      Logger.log('error', `OCR failed: ${err.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // UI rendering helpers
  // ──────────────────────────────────────────────────────────────

  function _updateStatusBar() {
    const rawTotal  = rawStrokes.reduce((s, st) => s + st.length, 0);
    const simpTotal = rawStrokes.reduce((s, st) =>
      s + RDP.simplify(st, settings.rdpEpsilon).length, 0);
    const stats = RDP.reductionStats(rawTotal, simpTotal);

    document.getElementById('status-points').textContent =
      `Points: ${rawTotal} raw / ${simpTotal} simplified`;
    document.getElementById('status-reduction').textContent =
      `Reduction: ${stats.percent}% (${stats.ratio}×)`;
    document.getElementById('status-strokes').textContent =
      `Strokes: ${rawStrokes.length}`;
    document.getElementById('status-clusters').textContent =
      `Clusters: ${lastPayload ? lastPayload.stats.clusterCount : 0}`;
  }

  function _renderPayloadPanel(payload) {
    // Show a compact summary (not the full 64×2 normalised arrays)
    const display = {
      ...payload,
      strokes: payload.strokes.map(sf => sf ? {
        index:       sf.index,
        pointCount:  sf.pointCount,
        arcLength:   sf.arcLength,
        direction:   sf.direction,
        curvature:   sf.curvature,
        aspectRatio: sf.aspectRatio,
        avgVelocity: sf.avgVelocity,
        boundingBox: sf.boundingBox
        // normalised omitted for readability
      } : null),
      simplifiedStrokes: payload.simplifiedStrokes.map(s => `[${s.length} pts]`)
    };
    document.getElementById('payload-output').textContent =
      JSON.stringify(display, null, 2);
  }

  function _renderOCRResult(result) {
    document.getElementById('ocr-result').textContent =
      result.text || '—';

    const candidatesEl = document.getElementById('ocr-candidates');
    candidatesEl.innerHTML = '';

    // Flatten all candidates from all words
    const allCandidates = [];
    (result.words || []).forEach((w, wi) => {
      (w.candidates || []).forEach((c, ci) => {
        allCandidates.push({ char: c.char, conf: c.confidence, top: ci === 0 });
      });
    });

    allCandidates.slice(0, 12).forEach(c => {
      const chip = document.createElement('div');
      chip.className = 'candidate-chip' + (c.top ? ' top' : '');
      chip.title = `confidence: ${c.conf}`;
      chip.textContent = `${c.char} ${(c.conf * 100).toFixed(0)}%`;
      candidatesEl.appendChild(chip);
    });
  }

  function setOCRStatus(state) {
    const el = document.getElementById('ocr-status');
    el.className = `badge badge-${state}`;
    el.textContent = state;
  }

  // ──────────────────────────────────────────────────────────────
  // Calibration flow
  // ──────────────────────────────────────────────────────────────

  /** Start the guided alphabet calibration sequence. */
  function _startCalibration() {
    _calibrationMode = true;
    _calibCurrentIdx = 0;
    _shortcutMatch   = null;

    // Clear canvas and engine state for a clean slate
    _clearCanvasOnly();

    // Show calibration UI
    _updateCalibOverlay();
    document.getElementById('calib-control-bar').hidden = false;
    document.getElementById('calib-ghost-layer').classList.add('active');

    // Hide shortcut box during calibration
    document.getElementById('shortcut-box').hidden = true;
    _clearShortcutLiveMatch();

    Logger.log('calib', 'Calibration started. Draw each letter when prompted.');
  }

  /** Update the calibration overlay to reflect the current letter. */
  function _updateCalibOverlay() {
    const letter = CalibrationManager.ALPHABET[_calibCurrentIdx];
    const idx    = _calibCurrentIdx;
    const total  = 26;
    const pct    = Math.round((idx / total) * 100);

    document.getElementById('calib-ghost-letter').textContent  = letter;
    document.getElementById('calib-current-letter').textContent = letter;
    document.getElementById('calib-step-num').textContent       = String(idx + 1);
    document.getElementById('calib-progress-fill').style.width  = `${pct}%`;
    document.getElementById('calib-progress-text').textContent  = `${idx} / ${total}`;
  }

  /**
   * Accept the current letter drawing and advance to the next.
   * Called when user clicks "Accept →".
   */
  function _calibAccept() {
    if (rawStrokes.length === 0) {
      Logger.log('warn', 'Draw the letter first before accepting.');
      return;
    }

    const letter     = CalibrationManager.ALPHABET[_calibCurrentIdx];
    const simplified = rawStrokes.map(s => RDP.simplify(s, settings.rdpEpsilon));

    const ok = CalibrationManager.storeLetter(letter, simplified);
    if (!ok) {
      Logger.log('warn', `Could not store letter '${letter}' — not enough points.`);
      return;
    }

    Logger.log('calib', `Stored '${letter}' (${rawStrokes.length} stroke(s)).`);

    _calibCurrentIdx++;
    _clearCanvasOnly();

    if (_calibCurrentIdx >= 26) {
      _finishCalibration();
    } else {
      _updateCalibOverlay();
    }
  }

  /** Clear just the canvas strokes without resetting OCR/engine state. */
  function _clearCanvasOnly() {
    rawStrokes    = [];
    currentStroke = null;
    isDrawing     = false;
    clearTimeout(settleTimer);
    settleTimer   = null;
    _predThrottle = 0;

    const dw = document.getElementById('draw-canvas');
    const rw = document.getElementById('rdp-canvas');
    const cw = document.getElementById('cluster-canvas');
    drawCtx.clearRect(0, 0, dw.width, dw.height);
    rdpCtx.clearRect(0, 0, rw.width, rw.height);
    clusterCtx.clearRect(0, 0, cw.width, cw.height);

    StrokeEngine.reset();
    _renderPredictionBox(null);
    _updateStatusBar();
  }

  /** Run analysis after all 26 letters are recorded; show results. */
  async function _finishCalibration() {
    // Update progress to 100% and show analyzing state
    document.getElementById('calib-progress-fill').style.width = '100%';
    document.getElementById('calib-progress-text').textContent = '26 / 26';
    document.getElementById('calib-current-letter').textContent = '✓';
    document.getElementById('calib-hint').textContent = 'Analysing your handwriting…';
    document.getElementById('btn-calib-accept').disabled = true;
    document.getElementById('btn-calib-clear').disabled  = true;

    // Yield to let the DOM repaint before the blocking analysis
    await new Promise(r => setTimeout(r, 60));

    const shortcuts = CalibrationManager.analyzeShortcuts();
    const count     = Object.keys(shortcuts).length;

    Logger.log('calib',
      `Analysis complete. Found ${count} shortcut(s) out of ` +
      `${CalibrationManager.profileLetterCount()} calibrated letters.`
    );

    // Tear down calibration mode
    _calibrationMode = false;
    document.getElementById('calib-control-bar').hidden = true;
    document.getElementById('calib-ghost-layer').classList.remove('active');
    document.getElementById('btn-calib-accept').disabled = false;
    document.getElementById('btn-calib-clear').disabled  = false;

    _clearCanvasOnly();
    _renderShortcutBox(shortcuts);
  }

  /** Cancel calibration mid-flow. */
  function _cancelCalibration() {
    _calibrationMode = false;
    document.getElementById('calib-control-bar').hidden = true;
    document.getElementById('calib-ghost-layer').classList.remove('active');
    _clearCanvasOnly();

    // Restore shortcut box if we had shortcuts before
    if (CalibrationManager.hasShortcuts()) {
      document.getElementById('shortcut-box').hidden = false;
    }

    Logger.log('calib', 'Calibration cancelled.');
  }

  // ──────────────────────────────────────────────────────────────
  // Shortcut box rendering
  // ──────────────────────────────────────────────────────────────

  /**
   * Render the shortcut analysis results box.
   * @param {Object} shortcuts  - { letter: { pct } }
   */
  function _renderShortcutBox(shortcuts) {
    const box      = document.getElementById('shortcut-box');
    const chips    = document.getElementById('shortcut-chips-row');
    const countBdg = document.getElementById('shortcut-count-badge');

    const entries = Object.entries(shortcuts)
      .sort((a, b) => a[1].pct - b[1].pct);  // sort by threshold ascending

    chips.innerHTML = '';

    if (entries.length === 0) {
      box.hidden = false;
      countBdg.textContent = '0 shortcuts found';
      chips.innerHTML =
        '<span style="font-size:11px;color:var(--text-dim);opacity:0.6">' +
        'No letters were uniquely identifiable before 90% completion.</span>';
      return;
    }

    countBdg.textContent = `${entries.length} / 26 letters shortcuttable`;

    for (const [letter, info] of entries) {
      const pctLabel = `${Math.round(info.pct * 100)}%`;
      const chip = document.createElement('div');
      chip.className = 'shortcut-chip';
      chip.title     = `'${letter}' is uniquely identifiable at ${pctLabel} completion`;
      chip.innerHTML =
        `<span class="shortcut-chip-letter">${_escHtml(letter)}</span>` +
        `<span class="shortcut-chip-pct">${pctLabel}</span>`;
      chips.appendChild(chip);
    }

    box.hidden = false;
  }

  /**
   * Flash the live shortcut match indicator in the shortcut box.
   * @param {{ letter, distance, pct }} match
   */
  function _renderShortcutLiveMatch(match) {
    const el     = document.getElementById('shortcut-live-match');
    const letter = document.getElementById('shortcut-live-letter');
    const detail = document.getElementById('shortcut-live-detail');

    letter.textContent = match.letter;
    detail.textContent =
      `dist ${match.distance.toFixed(3)} · threshold ${Math.round(match.pct * 100)}%`;

    el.hidden = false;
    // Re-trigger pulse animation
    el.classList.remove('shortcut-pulse-reset');
    void el.offsetWidth;  // force reflow
  }

  /** Hide the live match indicator. */
  function _clearShortcutLiveMatch() {
    document.getElementById('shortcut-live-match').hidden = true;
  }

  // ──────────────────────────────────────────────────────────────
  // Toolbar bindings
  // ──────────────────────────────────────────────────────────────

  function _setupToolbar() {
    const rdpSlider  = document.getElementById('rdp-epsilon');
    const rdpVal     = document.getElementById('rdp-epsilon-val');
    const penSlider  = document.getElementById('pen-size');
    const penVal     = document.getElementById('pen-size-val');
    const showRDP    = document.getElementById('show-rdp');
    const useSmooth  = document.getElementById('use-smooth');

    rdpSlider.addEventListener('input', () => {
      settings.rdpEpsilon = +rdpSlider.value;
      rdpVal.textContent  = (+rdpSlider.value).toFixed(1);
      _redrawRDPOverlay();
      if (rawStrokes.length > 0) _schedulePipeline();
    });

    penSlider.addEventListener('input', () => {
      settings.penSize  = +penSlider.value;
      penVal.textContent = penSlider.value;
    });

    showRDP.addEventListener('change', () => {
      settings.showRDP = showRDP.checked;
      _redrawRDPOverlay();
    });

    useSmooth.addEventListener('change', () => {
      settings.useSmoothing = useSmooth.checked;
      if (rawStrokes.length > 0) _schedulePipeline();
    });

    document.getElementById('btn-clear').addEventListener('click', _clearAll);

    // ── Calibration ──
    document.getElementById('btn-calibrate').addEventListener('click', _startCalibration);
    document.getElementById('btn-calib-accept').addEventListener('click', _calibAccept);
    document.getElementById('btn-calib-clear').addEventListener('click', _clearCanvasOnly);
    document.getElementById('btn-calib-cancel').addEventListener('click', _cancelCalibration);
    document.getElementById('btn-recalibrate').addEventListener('click', () => {
      CalibrationManager.clearAll();
      document.getElementById('shortcut-box').hidden = true;
      _clearShortcutLiveMatch();
      _startCalibration();
    });

    // Keyboard shortcut: Space / Enter accepts during calibration
    document.addEventListener('keydown', (e) => {
      if (!_calibrationMode) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        _calibAccept();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        _clearCanvasOnly();
      } else if (e.key === 'Escape') {
        _cancelCalibration();
      }
    });

    document.getElementById('btn-run-tests').addEventListener('click', () => {
      Logger.log('test', '── Running RDP unit tests ──');
      const results = RDP.runTests();
      const passed  = results.filter(r => r.passed).length;
      Logger.log(passed === results.length ? 'test' : 'error',
        `Tests complete: ${passed}/${results.length} passed`);
    });

    document.getElementById('btn-export').addEventListener('click', () => {
      if (!lastPayload) { Logger.log('info', 'Nothing to export yet.'); return; }
      const blob = new Blob([JSON.stringify(lastPayload, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `shorthanded_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      Logger.log('info', 'Payload exported as JSON.');
    });

    document.getElementById('btn-clear-log').addEventListener('click', Logger.clear);

    // ── DTW threshold slider ──
    const dtwSlider = document.getElementById('dtw-threshold');
    const dtwVal    = document.getElementById('dtw-threshold-val');
    dtwSlider.addEventListener('input', () => {
      settings.dtwThreshold = +dtwSlider.value;
      dtwVal.textContent    = (+dtwSlider.value).toFixed(2);
      // Re-run match with new threshold against current drawing
      if (rawStrokes.length > 0 && !DTW.isEmpty()) {
        const allSimp = rawStrokes.map(s => RDP.simplify(s, settings.rdpEpsilon));
        _runDTWMatch(allSimp);
      }
    });

    // ── Save as Template ──
    document.getElementById('btn-save-template').addEventListener('click', () => {
      if (rawStrokes.length === 0) {
        Logger.log('warn', 'Nothing drawn — draw something first.');
        return;
      }
      const text = window.prompt('Enter the text for this template (e.g. "Best regards,"):');
      if (text === null) return;       // user cancelled
      if (!text.trim()) {
        Logger.log('warn', 'Template text cannot be empty.');
        return;
      }
      const simplified = rawStrokes.map(s => RDP.simplify(s, settings.rdpEpsilon));
      const entry      = DTW.save(text, simplified);
      Logger.log('dtw',
        `Template saved: "${entry.text}" (id=${entry.id}, ` +
        `${entry.strokeCount} strokes, N=${entry.N})`
      );
      _renderDictPanel();
      // Immediately test the just-saved template against itself
      _runDTWMatch(simplified);
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Panel buttons
  // ──────────────────────────────────────────────────────────────

  function _setupPanelButtons() {
    document.getElementById('btn-copy-payload').addEventListener('click', () => {
      const text = document.getElementById('payload-output').textContent;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() =>
          Logger.log('info', 'Payload copied to clipboard.')
        );
      } else {
        Logger.log('info', 'Clipboard API not available.');
      }
    });

    // ── Dictionary export ──
    document.getElementById('btn-dict-export').addEventListener('click', () => {
      if (DTW.isEmpty()) { Logger.log('warn', 'Dictionary is empty.'); return; }
      const blob = new Blob([DTW.exportJSON()], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `shorthanded_dict_${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      Logger.log('info', `Dictionary exported (${DTW.count()} templates).`);
    });

    // ── Dictionary import ──
    const importBtn  = document.getElementById('btn-dict-import');
    const importFile = document.getElementById('dict-import-file');
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const n = DTW.importJSON(ev.target.result);
          Logger.log('dtw', `Imported ${n} template(s) from "${file.name}".`);
          _renderDictPanel();
        } catch (err) {
          Logger.log('error', `Import failed: ${err.message}`);
        }
      };
      reader.readAsText(file);
      e.target.value = '';   // reset so same file can be re-imported
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Clear
  // ──────────────────────────────────────────────────────────────

  function _clearAll() {
    rawStrokes  = [];
    currentStroke = null;
    lastPayload = null;
    isDrawing   = false;

    // Clear prediction engine state
    StrokeEngine.reset();
    clearTimeout(settleTimer);
    settleTimer   = null;
    _predThrottle = 0;
    _shortcutMatch = null;
    _renderPredictionBox(null);
    _clearShortcutLiveMatch();

    // Clear DTW match display and dictionary score badges
    document.getElementById('dtw-match-row').classList.add('dtw-hidden');
    document.querySelectorAll('.dict-entry-dist').forEach(el => {
      el.className = 'dict-entry-dist dist-hidden';
      el.textContent = '—';
    });
    document.querySelectorAll('.dict-entry').forEach(el => {
      el.classList.remove('dtw-best-match');
    });

    const dw = document.getElementById('draw-canvas');
    const rw = document.getElementById('rdp-canvas');
    const cw = document.getElementById('cluster-canvas');

    drawCtx.clearRect(0, 0, dw.width, dw.height);
    rdpCtx.clearRect(0, 0, rw.width, rw.height);
    clusterCtx.clearRect(0, 0, cw.width, cw.height);

    document.getElementById('payload-output').textContent = '(draw something…)';
    document.getElementById('ocr-result').textContent = '—';
    document.getElementById('ocr-candidates').innerHTML = '';
    setOCRStatus('idle');
    _updateStatusBar();
    Logger.log('info', 'Canvas cleared.');
  }

  // ──────────────────────────────────────────────────────────────
  // Public surface (minimal — mainly for console debugging)
  // ──────────────────────────────────────────────────────────────
  return { init };

})();

// ── Boot ──
document.addEventListener('DOMContentLoaded', App.init);
