# Claude Code Project Prompt: Shorthanded Foundation

**Role:** You are an expert Software Engineer and AI Specialist.

**Objective:** Build the foundational application and architecture for **"Shorthanded"**—an advanced, real-time handwriting analysis and OCR software. The software's ultimate goal is to process and understand abbreviated, low-stroke handwriting (shorthand) efficiently.

To ensure "Shorthanded" runs flawlessly, you must provide all the necessary logic, UI, preprocessing algorithms, and structural assets.

## Project Requirements:

### 1. The Input Interface (MS Paint-Style Canvas)
- Build a smooth, frictionless drawing area (e.g., HTML5 Canvas + Pointer Events or a robust desktop equivalent if you choose Python).
- It must accurately capture "stokes" as series of points. Each point must record `x` coordinates, `y` coordinates, and a `timestamp` `t` (and `pressure` if available) to capture the *dynamic* nature of handwriting.
- The interface must support continuous, real-time drawing without lag. 

### 2. Advanced Preprocessing (The Ramer-Douglas-Peucker Algorithm)
- "Shorthanded" requires highly optimized input parsing to reduce token usage and analytical overhead for the OCR engine. 
- Implement the **Ramer–Douglas–Peucker (RDP) algorithm** to simplify the captured strokes in real-time. You must provide a clean, highly optimized mathematical implementation of this algorithm.
- The simplified stroke data should retain the essential geometry of the letters while dramatically reducing the number of points processed.
- Optional: Add moving-average or Catmull-Rom spline smoothing to ensure the RDP output preserves organic handwriting curves.

### 3. Data Structuring and Real-time OCR Pipeline
- Build an event-driven pipeline that takes the raw strokes, passes them through the RDP simplifier, and bundles them into an optimized JSON data structure.
- Extract stroke features directly needed for shorthand analysis: 
  - Direction/angle tracking
  - Velocity/speed (derived from timestamps)
  - Stroke clustering (grouping strokes together based on temporal and spatial proximity representing a "word").
- Create a mock or stubbed real-time OCR service worker/API interface that accepts this optimized payload.

### 4. Assets for 'Shorthanded' to Run Flawlessly
- Because "Shorthanded" is designed to recognize text with *fewer strokes*, provide an architecture that handles high levels of ambiguity and context-dependent decoding.
- Include all necessary project files to run out of the box (e.g., `index.html`, `styles.css`, `app.js`, geometry utilities, Web Workers for background processing to avoid UI blocking).
- Provide placeholder code for the ML integration where the RDP-reduced strokes are vectorized and classified.

## Output Expectations:
1. Provide a step-by-step **Implementation Plan**.
2. Generate all the necessary interconnected files. Be extremely robust in your canvas setup and the RDP algorithm implementation.
3. Include unit tests or inline testing logic for the RDP algorithm to prove point-reduction correctness.
4. Ensure the resulting project can be run immediately (e.g., via a simple local server) so the user can test the drawing and see the real-time RDP stroke simplification logs in the console.
