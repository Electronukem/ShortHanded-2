/* ═══════════════════════════════════════════════════════════════
   ocr-service.js — Main-thread OCR service interface
   Exposed as: window.OCRService

   Responsibilities:
   ─────────────────
   1. Owns the Web Worker instance (ocr-worker.js)
   2. Provides a Promise-based API: OCRService.process(payload)
   3. Routes worker progress messages to Logger
   4. Provides a fallback synchronous path if Workers are blocked
      (e.g., file:// restrictions in some browsers)
   5. Exposes ML integration stubs so developers can swap in
      real inference engines without changing app.js

   ML Integration stub
   ───────────────────
   Replace the THREE stub methods below to wire in a real engine:
     • loadModel(url)       → loads a TFLite / ONNX model
     • runInference(vector) → returns character probabilities
     • contextDecode(probs) → LM re-scoring / beam search

   The worker already calls these shapes; swapping them in the
   worker is sufficient for a full-stack integration.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const OCRService = (() => {

  // ──────────────────────────────────────────────────────────────
  // Worker management
  // ──────────────────────────────────────────────────────────────

  let _worker     = null;
  let _workerReady = false;
  let _pendingResolve   = null;
  let _pendingReject    = null;
  let _pendingPredResolve = null;  // separate promise slot for PREDICT
  let _onProgress       = null;   // callback set by app.js
  let _onPrediction     = null;   // callback set by app.js for worker predictions

  /**
   * Initialise the Web Worker.
   * Call once at startup. Safe to call again if the worker crashed.
   *
   * @param {Function} [onProgress]  - called with (message, pct) during processing
   * @returns {boolean}              - true if worker started successfully
   */
  function init(onProgress, onPrediction) {
    _onProgress   = onProgress   || null;
    _onPrediction = onPrediction || null;

    // Check if Workers are available (may be blocked on file://)
    if (typeof Worker === 'undefined') {
      Logger.log('warn', 'Web Workers not available — using synchronous fallback');
      _workerReady = false;
      return false;
    }

    try {
      _worker = new Worker('ocr-worker.js');
      _worker.onmessage  = _handleWorkerMessage;
      _worker.onerror    = _handleWorkerError;
      _workerReady = true;

      // Ping to confirm worker loaded
      _worker.postMessage({ type: 'PING' });
      Logger.log('info', 'OCR worker initialised');
      return true;
    } catch (err) {
      Logger.log('error', `Worker init failed: ${err.message} — using fallback`);
      _workerReady = false;
      return false;
    }
  }

  /**
   * Process a ShorthandPayload through the OCR pipeline.
   * Returns a Promise that resolves with an OCRResult.
   *
   * @param {ShorthandPayload} payload
   * @returns {Promise<OCRResult>}
   */
  function process(payload) {
    if (_workerReady && _worker) {
      return _processInWorker(payload);
    } else {
      return _processFallback(payload);
    }
  }

  /**
   * Fire a PREDICT message to the worker — fast, stateless pattern
   * matching on the committed simplified strokes. Returns a Promise
   * that resolves with a PredictionResult.
   *
   * This is the worker-side cross-check. The main-thread StrokeEngine
   * already provides instant live predictions; this gives an async
   * confirmation (and future ML hook) after each pen-lift.
   *
   * @param {Array<Array<{x,y}>>} simplifiedStrokes
   * @param {boolean} settled
   * @returns {Promise<PredictionResult>}
   */
  function predict(simplifiedStrokes, settled = false) {
    if (!_workerReady || !_worker) {
      // Fallback: run synchronously on main thread using StrokeEngine
      return Promise.resolve(
        StrokeEngine.matchPatterns(
          simplifiedStrokes.flatMap(s => StrokeEngine.extractSegments(s)),
          settled
        )
      );
    }
    return new Promise(resolve => {
      _pendingPredResolve = resolve;
      _worker.postMessage({ type: 'PREDICT', strokes: simplifiedStrokes, settled });
    });
  }

  // ── Worker path ──

  function _processInWorker(payload) {
    return new Promise((resolve, reject) => {
      _pendingResolve = resolve;
      _pendingReject  = reject;
      _worker.postMessage({ type: 'PROCESS', payload });
    });
  }

  function _handleWorkerMessage(e) {
    const { type, result, message, pct } = e.data;

    switch (type) {
      case 'PONG':
        Logger.log('info', 'OCR worker PONG received');
        break;

      case 'PROGRESS':
        if (_onProgress) _onProgress(message, pct);
        Logger.log('ocr', `[${pct}%] ${message}`);
        break;

      case 'RESULT':
        if (_pendingResolve) {
          _pendingResolve(result);
          _pendingResolve = null;
          _pendingReject  = null;
        }
        break;

      case 'PREDICTION':
        if (_pendingPredResolve) {
          _pendingPredResolve(e.data.prediction);
          _pendingPredResolve = null;
        }
        if (_onPrediction) _onPrediction(e.data.prediction);
        break;

      case 'ERROR':
        Logger.log('error', `OCR worker error: ${message}`);
        if (_pendingReject) {
          _pendingReject(new Error(message));
          _pendingResolve = null;
          _pendingReject  = null;
        }
        if (_pendingPredResolve) {
          _pendingPredResolve({ candidates: [], locked: false, display: '[?]', phase: 'unknown', segments: [] });
          _pendingPredResolve = null;
        }
        break;
    }
  }

  function _handleWorkerError(err) {
    Logger.log('error', `Worker crashed: ${err.message}`);
    // Restart worker
    _worker = null;
    _workerReady = false;
    if (_pendingReject) {
      _pendingReject(new Error(err.message));
      _pendingResolve = null;
      _pendingReject  = null;
    }
  }

  // ── Synchronous fallback path ──
  // Used when Workers are unavailable (file:// in Firefox, etc.)

  function _processFallback(payload) {
    Logger.log('ocr', 'Running OCR in fallback (main thread) mode');
    return new Promise(resolve => {
      // Minimal greedy decode — no worker overhead
      const words = payload.clusters.map(cluster => {
        const sf = payload.strokes[cluster.strokeIndices[0]];
        return _heuristicChar(sf);
      });
      const text = words.join(' ');
      resolve({
        text,
        confidence: 0.5,
        words: words.map(w => ({ text: w, confidence: 0.5, candidates: [{ char: w, confidence: 0.5 }] })),
        clusters: [],
        vectors: []
      });
    });
  }

  function _heuristicChar(sf) {
    if (!sf) return '?';
    const ar = sf.aspectRatio;
    if (ar > 2.5) return '-';
    if (ar < 0.4) return '|';
    return sf.direction === 'NE' ? '/' : (sf.direction === 'NW' ? '\\' : 'o');
  }

  // ──────────────────────────────────────────────────────────────
  // ██  ML INTEGRATION STUBS  ██
  // Replace these three functions with your real inference engine.
  // ──────────────────────────────────────────────────────────────

  /**
   * STUB: Load a pre-trained model.
   *
   * Example real implementation:
   *   const model = await tf.loadLayersModel(url);
   *   _model = model;
   *
   * @param {string} modelUrl  - path to model.json (TF.js) or .onnx
   * @returns {Promise<void>}
   */
  async function loadModel(modelUrl) {
    Logger.log('info', `[ML STUB] loadModel called with: ${modelUrl}`);
    // TODO: Replace with:
    //   const tf = window.tf;
    //   _mlModel = await tf.loadLayersModel(modelUrl);
    return Promise.resolve(null);
  }

  /**
   * STUB: Run inference on a 128-dim feature vector.
   *
   * Expected output: array of { char, probability } sorted descending.
   *
   * Example real implementation:
   *   const inputTensor = tf.tensor2d([vector], [1, 128]);
   *   const output = _mlModel.predict(inputTensor);
   *   const probs = await output.data();
   *   return CHARSET.map((c, i) => ({ char: c, probability: probs[i] }))
   *     .sort((a, b) => b.probability - a.probability);
   *
   * @param {Float32Array} vector   - 128-dim normalised stroke vector
   * @returns {Promise<Array<{char:string, probability:number}>>}
   */
  async function runInference(vector) {
    Logger.log('info', '[ML STUB] runInference called');
    // TODO: Replace with real model call
    return Promise.resolve([
      { char: '?', probability: 0.3 },
      { char: 'o', probability: 0.2 }
    ]);
  }

  /**
   * STUB: Context-aware language model decode (beam search / CTC).
   *
   * @param {Array<Array<{char,probability}>>} perClusterProbs
   * @returns {Promise<string>}    - decoded text
   */
  async function contextDecode(perClusterProbs) {
    Logger.log('info', '[ML STUB] contextDecode called');
    // TODO: Replace with n-gram LM re-scoring or transformer decoder
    return Promise.resolve(
      perClusterProbs.map(p => p[0]?.char ?? '?').join('')
    );
  }

  // ──────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────
  return {
    init,
    process,
    predict,
    // ML integration hooks (for external use / future wiring)
    loadModel,
    runInference,
    contextDecode,
    get isWorkerReady() { return _workerReady; }
  };

})();

window.OCRService = OCRService;
