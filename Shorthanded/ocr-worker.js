/* ═══════════════════════════════════════════════════════════════
   ocr-worker.js — Web Worker: background OCR pipeline processor
   ───────────────────────────────────────────────────────────────
   This file runs in a separate worker thread, keeping the main
   UI thread free of heavy computation.

   Message protocol (main → worker):
     { type: 'PROCESS', payload: ShorthandPayload }
     { type: 'PING' }

   Message protocol (worker → main):
     { type: 'RESULT',   result: OCRResult }
     { type: 'PROGRESS', message: string, pct: number }
     { type: 'ERROR',    message: string }
     { type: 'PONG' }

   NOTE: The Web Worker cannot import ES modules by default in all
   browsers. We use importScripts() for the shared utilities.
   Because this project is served from a local file server, all
   paths are relative.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// Import shared utilities into the worker scope
// (These expose globals: RDP, GeoUtils, StrokeEngine — same code, worker context)
importScripts('geometry-utils.js', 'rdp.js', 'stroke-engine.js');

// ──────────────────────────────────────────────────────────────
// Message handler
// ──────────────────────────────────────────────────────────────

self.onmessage = function (e) {
  const { type, payload } = e.data;

  switch (type) {

    case 'PING':
      self.postMessage({ type: 'PONG' });
      break;

    case 'PROCESS':
      try {
        const result = runOCRPipeline(payload);
        self.postMessage({ type: 'RESULT', result });
      } catch (err) {
        self.postMessage({ type: 'ERROR', message: err.message });
      }
      break;

    // ── PREDICT: partial-stroke recognition via StrokeEngine ──
    // Receives an array of already-simplified stroke point arrays.
    // Runs segment extraction + pattern matching and returns a
    // PredictionResult without the full OCR pipeline overhead.
    case 'PREDICT':
      try {
        const prediction = runPredictPipeline(e.data.strokes, e.data.settled);
        self.postMessage({ type: 'PREDICTION', prediction });
      } catch (err) {
        self.postMessage({ type: 'ERROR', message: err.message });
      }
      break;

    default:
      self.postMessage({ type: 'ERROR', message: `Unknown message type: ${type}` });
  }
};

// ──────────────────────────────────────────────────────────────
// OCR Pipeline stages
// ──────────────────────────────────────────────────────────────

/**
 * Main OCR pipeline. Receives the fully processed ShorthandPayload
 * and returns an OCRResult.
 *
 * Stages:
 *   1. Vectorise — convert strokes to normalised feature vectors
 *   2. Classify  — ML stub: map vectors to candidate characters
 *   3. Decode    — context-aware beam search over candidates
 *   4. Return result
 *
 * @param {ShorthandPayload} payload
 * @returns {OCRResult}
 */
function runOCRPipeline(payload) {

  progress('Vectorising strokes…', 10);

  // ── Stage 1: Vectorisation ──
  const vectors = vectorisePayload(payload);

  progress('Classifying stroke vectors…', 40);

  // ── Stage 2: Classification (ML stub) ──
  const clusterResults = payload.clusters.map((cluster, ci) => {
    const clusterVectors = cluster.strokeIndices.map(i => vectors[i]);
    return classifyCluster(cluster, clusterVectors, payload.strokes);
  });

  progress('Decoding candidates…', 75);

  // ── Stage 3: Beam-search decode ──
  const decoded = beamDecode(clusterResults);

  progress('Done.', 100);

  return {
    text:       decoded.text,
    confidence: decoded.confidence,
    words:      decoded.words,
    clusters:   clusterResults,
    vectors:    vectors.map(v => Array.from(v).slice(0, 8)) // truncate for readability
  };
}

// ──────────────────────────────────────────────────────────────
// Stage 1: Vectorisation
// ──────────────────────────────────────────────────────────────

/**
 * Convert each stroke's normalised 64-point path into a flat
 * 128-dimensional feature vector [x0,y0, x1,y1, …, x63,y63].
 * Coordinates are centred and scale-normalised to [-1, 1].
 *
 * @param {ShorthandPayload} payload
 * @returns {Float32Array[]}
 */
function vectorisePayload(payload) {
  return payload.strokes.map(stroke => {
    const pts = stroke.normalised;          // 64 × [x, y] from StrokeProcessor
    const vec = new Float32Array(128);

    // Compute bounding extent for normalisation
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of pts) {
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    const rngX = maxX - minX || 1;
    const rngY = maxY - minY || 1;

    for (let i = 0; i < pts.length; i++) {
      vec[i * 2]     = (pts[i][0] - minX) / rngX * 2 - 1;
      vec[i * 2 + 1] = (pts[i][1] - minY) / rngY * 2 - 1;
    }

    return vec;
  });
}

// ──────────────────────────────────────────────────────────────
// Stage 2: Classification stub (ML placeholder)
// ──────────────────────────────────────────────────────────────

/**
 * STUB — Replace this function with a real ML model call.
 *
 * Current behaviour: uses heuristic rules on stroke geometry
 * (aspect ratio, curvature, direction sequence) to produce
 * plausible candidate characters with mock confidence scores.
 *
 * @param {WordCluster} cluster
 * @param {Float32Array[]} vectors       - one per stroke in cluster
 * @param {StrokeFeatures[]} allFeatures - full feature set
 * @returns {ClusterClassification}
 */
function classifyCluster(cluster, vectors, allFeatures) {

  const candidates = [];
  const dirSeq = cluster.directionSequence.join('');

  // Heuristic shortcuts (shorthand-inspired, not accurate):
  // These would be replaced by a real embedding + nearest-neighbour
  // lookup or a lightweight TFLite model.

  const strokes = cluster.strokeIndices.map(i => allFeatures[i]);

  // Single-stroke heuristics
  if (cluster.strokeCount === 1) {
    const sf = strokes[0];
    const ar = sf.aspectRatio;
    const curv = sf.curvature;

    if (ar > 2.5 && curv < 0.5)  { addCandidate(candidates, '-', 0.82); addCandidate(candidates, '_', 0.60); }
    else if (ar < 0.4 && curv < 0.5) { addCandidate(candidates, '|', 0.80); addCandidate(candidates, 'l', 0.55); }
    else if (ar > 0.8 && ar < 1.3 && curv > 2) { addCandidate(candidates, 'o', 0.75); addCandidate(candidates, '0', 0.50); }
    else if (sf.direction === 'NE' || sf.direction === 'SW') { addCandidate(candidates, '/', 0.70); addCandidate(candidates, 'v', 0.45); }
    else if (sf.direction === 'NW' || sf.direction === 'SE') { addCandidate(candidates, '\\', 0.68); addCandidate(candidates, 'z', 0.40); }
    else { addCandidate(candidates, '?', 0.30); }
  }

  // Multi-stroke heuristics
  else if (cluster.strokeCount === 2) {
    const ar0 = strokes[0] ? strokes[0].aspectRatio : 1;
    const ar1 = strokes[1] ? strokes[1].aspectRatio : 1;
    if (ar0 > 2 && ar1 < 0.5) { addCandidate(candidates, 't', 0.72); addCandidate(candidates, '+', 0.60); }
    else if (ar0 < 0.5 && ar1 < 0.5) { addCandidate(candidates, 'i', 0.65); addCandidate(candidates, 'j', 0.40); }
    else { addCandidate(candidates, 'n', 0.50); addCandidate(candidates, 'u', 0.45); }
  }

  else {
    // 3+ strokes — complex character or whole word
    addCandidate(candidates, '#', 0.40);
    addCandidate(candidates, 'w', 0.35);
    addCandidate(candidates, 'm', 0.30);
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  return {
    clusterIndex: cluster.index,
    candidates,
    topChar:      candidates[0] ? candidates[0].char : '?',
    topConf:      candidates[0] ? candidates[0].confidence : 0
  };
}

function addCandidate(list, char, confidence) {
  list.push({ char, confidence: +confidence.toFixed(3) });
}

// ──────────────────────────────────────────────────────────────
// Stage 3: Beam-search decoder (stub)
// ──────────────────────────────────────────────────────────────

/**
 * STUB — Replace with a real language model or n-gram decoder.
 *
 * Current behaviour: greedy pick of top candidate per cluster.
 * A real implementation would use:
 *   - CTC / attention beam search
 *   - Character-level language model re-scoring
 *   - Greedy shorthand expansion rules
 *
 * @param {ClusterClassification[]} clusterResults
 * @returns {{ text: string, confidence: number, words: WordDecoding[] }}
 */
function beamDecode(clusterResults) {
  const words = clusterResults.map(cr => ({
    text:       cr.topChar,
    confidence: cr.topConf,
    candidates: cr.candidates
  }));

  const text = words.map(w => w.text).join(' ');
  const confidence = words.length
    ? +(words.reduce((s, w) => s + w.confidence, 0) / words.length).toFixed(3)
    : 0;

  return { text, confidence, words };
}

// ──────────────────────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────────────────────

function progress(message, pct) {
  self.postMessage({ type: 'PROGRESS', message, pct });
}

// ──────────────────────────────────────────────────────────────
// PREDICT pipeline — fast, stateless, no ML overhead
// ──────────────────────────────────────────────────────────────

/**
 * Stateless partial-recognition pipeline using StrokeEngine.
 * Called via the PREDICT message from the main thread after each
 * committed stroke so the worker can cross-check the live result.
 *
 * @param {Array<Array<{x,y}>>} strokes  - simplified stroke arrays
 * @param {boolean} settled              - true if temporal gap elapsed
 * @returns {PredictionResult}
 */
function runPredictPipeline(strokes, settled) {
  if (!strokes || strokes.length === 0) {
    return { candidates: [], locked: false, display: '—', phase: 'empty', segments: [] };
  }

  // Build flat segment sequence across all provided strokes
  const allSegs = [];
  for (const stroke of strokes) {
    if (stroke && stroke.length >= 2) {
      allSegs.push(...StrokeEngine.extractSegments(stroke));
    }
  }

  return StrokeEngine.matchPatterns(allSegs, settled);
}
