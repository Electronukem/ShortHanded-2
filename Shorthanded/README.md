# Shorthanded

Real-time handwriting analysis and shorthand OCR — built entirely in vanilla HTML/CSS/JS with no dependencies, no build step, and no framework.

Draw on the canvas and watch the engine predict what you're writing *while you're still drawing it*.

![prediction bar showing v/w disambiguation](.github/preview.png)

---

## What it does

**Shorthanded** captures freehand strokes, reduces them with the Ramer–Douglas–Peucker algorithm, extracts directional geometry, and runs a pattern-matching engine against a dictionary of character shapes — all in real time.

The core goal: recognise characters with the *fewest possible strokes*, eliminating ambiguity as each new segment of ink arrives rather than waiting for a complete letter.

### The v / w demonstration

This is the canonical example of the engine's logic:

| What you've drawn | Engine output | Why |
|---|---|---|
| One downstroke | `[\ / v… / w…]` | Prefix-matches several patterns |
| Down → up (V-shape) | `[v / w? / n?]` | `v` is complete; `w` and `n` still viable |
| Down → up → down | `[n / w? / m?]` | `v` **eliminated**; `n` complete; `w` still possible |
| Down → up → down → up | `[w / m?]` | `w` complete; only `m` could continue further |
| Pause 650 ms | **`w`** ✓ | Settled — locked to best complete match |

---

## Running it

Serve the `Shorthanded/` folder from any local HTTP server:

```bash
# Python
python -m http.server 8080

# Node (npx)
npx serve .

# VS Code
# Install the "Live Server" extension → right-click index.html → Open with Live Server
```

Then open `http://localhost:8080` in your browser. No install, no build.

> **Note:** The project uses a Web Worker (`ocr-worker.js`) for background processing. Web Workers require an HTTP server — opening `index.html` directly as a `file://` URL will fall back to synchronous main-thread processing automatically, but the worker-based pipeline won't run.

---

## Architecture

```
Shorthanded/
├── index.html          # Shell: canvas layers, prediction bar, right panels
├── styles.css          # Dark UI, phase-reactive prediction bar, all components
│
├── geometry-utils.js   # Point math, bounding box, Catmull-Rom spline,
│                       #   moving-average smoothing, arc-length resampler
│
├── rdp.js              # Ramer–Douglas–Peucker algorithm (iterative, O(N log N))
│                       #   + 9 inline unit tests (Run RDP Tests button)
│
├── stroke-engine.js    # ★ Partial-stroke recognition state machine
│                       #   Directional segment extraction → pattern matching
│                       #   Works on both main thread and in the Web Worker
│
├── stroke-processor.js # Feature extraction: direction, velocity, curvature,
│                       #   pressure, arc-length, bounding box, word clustering
│
├── ocr-worker.js       # Web Worker: PROCESS (full pipeline) + PREDICT (fast
│                       #   pattern match) message handlers
│
├── ocr-service.js      # Main-thread service: owns the Worker, exposes
│                       #   process() and predict() as Promises, ML stubs
│
└── app.js              # Canvas controller, pointer events, overlays, toolbar,
                        #   Logger, settle timer, cluster detection
```

### Data flow

```
Pointer events
    │
    ▼
Raw stroke points  {x, y, t, pressure}
    │
    ├──► (every 4 points, main thread)
    │         RDP.simplify()
    │              │
    │              ▼
    │         StrokeEngine.updateLive()
    │              │
    │              ▼
    │         matchPatterns()  ──►  Prediction bar  (instant)
    │
    └──► (on pen-lift)
              RDP.simplify()
                   │
                   ├──► StrokeEngine.commitStroke()  ──►  Prediction bar
                   │
                   ├──► [settle timer: 650 ms]  ──►  StrokeEngine.settle()  ──►  Locked prediction
                   │
                   └──► OCRService.process()  ──►  [Web Worker]
                              │
                              ├── Vectorise (128-dim Float32Array per stroke)
                              ├── Classify  (heuristic stub → ML hook)
                              └── Decode    (greedy beam search stub)
                                       │
                                       ▼
                                  OCR Result panel
```

---

## Key algorithms

### Ramer–Douglas–Peucker (rdp.js)

Reduces the raw point cloud of each stroke to only the geometrically significant vertices. A stroke that captures 200 points while drawing a simple curve may reduce to 8–15 points, cutting the data fed to the recognition engine by 90%+.

The implementation is iterative (stack-based) to avoid call-stack overflow on long strokes.

**Epsilon (ε)** controls the trade-off — adjust with the slider in the toolbar. Higher ε = fewer points, faster but coarser.

### Directional segment extraction (stroke-engine.js)

After RDP, consecutive point-pairs are converted to 8-compass directions (screen coordinates, Y-down). Consecutive same-direction pairs are collapsed (run-length encoded), and segments shorter than 9% of total stroke length are filtered as jitter.

This produces a compact sequence like `[SE, NE, SE, NE]` that the pattern matcher can act on in microseconds.

### Pattern matching (stroke-engine.js)

Each character in the dictionary is defined as an ordered list of direction-group constraints:

```js
{ char: 'w', segs: ['DOWN', 'UP', 'DOWN', 'UP'] }
// DOWN = any of: S, SE, SW
// UP   = any of: N, NE, NW
```

The matcher finds all patterns where the current segment sequence is a valid **prefix**. It distinguishes:

- **Complete match** — all segments of the pattern are satisfied
- **Partial match** — current segments match the start of a longer pattern

When only one complete match exists with no longer viable paths, the prediction **locks**. When complete and partial matches coexist, it shows ambiguous candidates and waits for more strokes or the settle timeout.

### Word clustering (stroke-processor.js)

Strokes are grouped into "word" clusters by two thresholds:
- **Spatial gap > 80 px** between stroke endpoints → new cluster
- **Temporal gap > 600 ms** between pen-up and next pen-down → new cluster

The prediction engine also uses these thresholds to reset its state when the user moves to a new word.

---

## Integrating a real ML model

Three stubs in `ocr-service.js` mark the integration points:

```js
// 1. Load a TF.js or ONNX model
OCRService.loadModel('model/shorthanded.json');

// 2. Run inference on a 128-dim stroke vector
// (called per stroke in ocr-worker.js → classifyCluster)
OCRService.runInference(float32Vector);

// 3. Language-model decode across cluster probabilities
OCRService.contextDecode(perClusterProbabilities);
```

Each stroke already arrives pre-vectorised as:
- A **128-dimensional `Float32Array`** `[x0,y0, x1,y1, … x63,y63]` — scale-normalised to [-1, 1]
- A **64-point arc-length resampled path** — uniform spacing, coordinate-normalised

Both representations are computed in `stroke-processor.js` before the worker ever sees the data.

---

## UI panels

| Panel | Contents |
|---|---|
| **Prediction bar** | Live character prediction, phase tag, candidate chips, directional segment pills |
| **OCR Result** | Post-pipeline character/word result with confidence |
| **Candidates** | All candidate characters and their confidence scores |
| **OCR Payload** | Full JSON payload sent to the recognition engine (copyable) |
| **Pipeline Log** | Timestamped log of every stage: strokes, RDP stats, cluster events, predictions |

### Toolbar controls

| Control | Effect |
|---|---|
| **RDP ε** | Simplification epsilon — drag right to reduce points more aggressively |
| **Size** | Pen stroke width |
| **Show RDP** | Toggle the orange simplified-path overlay |
| **Smooth** | Apply moving-average pre-smoothing before RDP |
| **Clear** | Wipe canvas and reset all engine state |
| **Run RDP Tests** | Execute 9 unit tests on the RDP algorithm, log pass/fail |
| **Export JSON** | Download the current stroke payload as `.json` |

---

## Browser support

Any modern browser with support for:
- Pointer Events API (pen/touch pressure)
- Web Workers
- Canvas 2D

Tested in Chrome 120+, Firefox 121+, Edge 120+.

---

## Roadmap / extension ideas

- [ ] Train and integrate a lightweight TFLite stroke classifier
- [ ] Gregg / Pitman shorthand symbol dictionary
- [ ] Multi-cluster sentence assembly with n-gram language model
- [ ] Export strokes as SVG
- [ ] Tablet / stylus pressure-to-weight rendering
- [ ] IndexedDB persistence for training data collection
