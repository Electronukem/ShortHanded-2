# Claude Code Project Prompt: Shorthanded Implementation (Phase 2)

**Role:** You are an expert Software Engineer and AI Specialist.

**Context:** You are working within the `Shorthanded` directory, building upon the foundational canvas and RDP (Ramer-Douglas-Peucker) stroke simplification code already present in the project files (e.g., `app.js`, `ocr-worker.js`, `stroke-processor.js`, `rdp.js`, `index.html`).

**Objective:** Implement the core logic of the "Shorthanded" program: **Early Stroke Recognition.** 

The goal of this software is to lower the number of strokes that need to be analyzed by recognizing letters *before* they are completely drawn. By analyzing partial stroke geometry, the program will anticipate the intended characters.

## Project Requirements:

### 1. Partial-Stroke Recognition Logic
- Update the OCR service or worker to analyze stroke structures dynamically as they are drawn.
- Build logic capable of recognizing letters without waiting for full completion of the standard letter form. Rely on stroke counting, initial vectors, and directional changes.
- **Implementation Example:** If the user draws a standard 'v' shape (two strokes/vectors), the system should acknowledge it could optionally be a 'v' or the beginning of a 'w'. *However*, the moment the third downward stroke begins (after the 'v' shape), the engine should logically eliminate 'v' and definitively recognize it as a 'w'.
- Create a rule engine, state-machine, or heuristic dictionary that maps partial stroke patterns (directional sequences) to likely character outcomes.

### 2. Real-Time OCR Demonstration Box
- To demonstrate that the predictive logic works as intended, modify the existing `index.html` and `styles.css`.
- Add a new **Real-time Prediction Box** positioned directly below the main drawing canvas.
- This box must dynamically output what the OCR currently thinks is being written, updating fluidly as new line segments are processed.
- It should visually represent ambiguity. For instance, if the engine is unsure whether a shape is a 'v' or 'w', it might display `[v/w?]`. Upon the third stroke, it should lock in to `w`.

### 3. Pipeline Integration
- Hook this logic into the output of the existing RDP algorithm. The point-reduced data is perfect for calculating rapid directional vectors (e.g., South-East, then North-East).
- Use the worker threads (`ocr-worker.js`) to ensure that calculating these real-time predictions does not cause the main canvas thread to lag while drawing.

## Output Expectations:
1. Examine the current codebase and integrate these requirements seamlessly into the existing structure. Modularity is key.
2. Implement the core matching algorithm that demonstrates the 'v' vs 'w' logic, along with a structure that easily supports expanding the alphabet.
3. Successfully render the UI box below the canvas that reacts in real-time to the stroke inputs.
