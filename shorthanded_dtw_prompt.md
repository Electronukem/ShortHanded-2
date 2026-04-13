# Claude Code Project Prompt: Shorthanded Implementation (Phase 3 - DTW)

**Role:** You are an expert Software Engineer and AI Algorithmic Specialist.

**Context:** You are working within the `Shorthanded` directory. We have successfully implemented raw stroke capture from an HTML5 Canvas, and streamlined the data reduction using the Ramer-Douglas-Peucker (RDP) algorithm.

**Objective:** Implement the next major architectural evolution: **Custom Shorthand Matching using Dynamic Time Warping (DTW).** 
Because Shorthanded is designed for speed, we want to bypass heavy neural networks and utilize DTW to instantly compare user-drawn strokes against a dictionary of "templates".

## Project Requirements:

### 1. Vector Normalization Logic
Before comparing two strokes, they must be mathematically standardized.
- Write a function that takes an RDP-simplified stroke array and **normalizes** it. 
- It must translate the stroke so its bounding box starts at `(0,0)` and scale the stroke so it sits perfectly within a `1x1` mathematical space. 
- *Why:* This ensures that if a user draws a huge loop, it still perfectly matches the tiny loop they saved as a template.

### 2. Implement Dynamic Time Warping (DTW)
- Provide a clean, highly optimized JavaScript implementation of the DTW algorithm.
- The algorithm must compare the normalized `(x, y)` coordinate sequence of the *current input* against a *saved template sequence*.
- It should calculate the Euclidean distance between the points across the time-warped alignment and yield a "cost" or "distance score". A lower score equals a higher match probability.

### 3. The "Teach the Engine" UI
- We need a way to assign meaning to arbitrary squiggles. Modify `index.html` and `styles.css` to add a new side panel or modal called **"Shorthand Dictionary"**.
- Add a **"Save as Macro/Template"** button beneath the canvas. 
- When clicked, it should prompt the user for a text string (e.g., "Best regards,"). It then takes the *currently drawn, RDP-simplified, normalized strokes* on the canvas and saves them into a JavaScript dictionary/JSON object mapping that shape to the text string.

### 4. Live Recognition Engine Integration
- Hook the DTW logic into the existing drawing pipeline (`app.js` / `stroke-processor.js`).
- Upon `pointerup` (when the pen lifts), trigger a background check. Run the normalized stroke data against all templates in the dictionary using the DTW algorithm.
- If the lowest DTW distance score falls below a set threshold, update the UI (the live prediction box) to confidently output the matched template string.

## Output Expectations:
1. Examine the current structure and implement `dtw.js` or integrate the logic into the geometry utils seamlessly. 
2. Ensure the DTW algorithm is efficient, as evaluating it against a large dictionary in real-time can be expensive.
3. Update the UI to allow for seamless saving of new templates and visually display the DTW distance scores in the console or debug logs so the user can see how confident the matching engine is.
