# Claude Code Project Prompt: Shorthanded Implementation (Phase 4 - Personalized Calibration)

**Role:** You are an expert Software Engineer and AI Algorithmic Specialist.

**Context:** You are working within the `Shorthanded` directory. We are building a high-speed handwriting engine that combines RDP stroke simplification with predictive recognition.

**Objective:** Implement **Personalized Baseline Calibration and Dynamic Shortcut Generation.** To achieve ultimate accuracy, the engine must understand a user's unique writing traits. Instead of hard-coding rules for when a letter can be predicted early, the system will learn the user's alphabet, analyze it mathematically, and auto-generate custom shortcuts (partial strokes) based on their specific handwriting.

## Project Requirements:

### 1. Alphabet Calibration Flow
- Add a **"Calibrate Alphabet"** button to the UI.
- When clicked, trigger a guided flow that asks the user to draw each lowercase letter of the alphabet (`a` through `z`), one at a time on the canvas.
- As they finish each letter, capture, normalize, and save the stroke sequence. 
- Store this final 26-letter array as the user's **Baseline Profile**.

### 2. Algorithmic "Shortcut" Discovery
- Once the 26 letters are recorded, run a background analysis function on the Baseline Profile.
- **The specific math:** For each of the 26 letters, iteratively truncate the stroke data (e.g., removing the last 10%, 20%, 30% of the points). Compare this partial stroke against the paths of the *other 25 full letters* (using your DTW or vector matching logic).
- Find the minimum threshold at which that partial letter remains 100% uniquely identifiable from the rest of the alphabet. 
- Example: If the user's `w` diverges drastically from their `v` halfway through the shape, flag `w` as a letter that can be shortcutted at 50% completion.

### 3. Testing UI & Output Box
- Modify `index.html` and `styles.css` to add a specific **"Shortcut Analysis Box"** situated on the bottom-left of the output area.
- In this box, list out the exact letters the system successfully found shortcuts for, based on the calibration. 
- This UI should act as a testing and feedback mechanism for the user, showing them which letters they no longer need to fully write out (e.g., `Found Shortcuts: 'w' (needs 50%), 'o' (needs 60%), 't' (needs 30%)`).

### 4. Integration into Live Recognition
- Wire this calibrated data back into the main drawing loop.
- The live predictive OCR engine must abandon generic rules and strictly use this user-calibrated profile. 
- As the user writes in real-time, the engine should constantly check the active stroke against the discovered shortcuts. The moment the partial stroke crosses the unique threshold for one of the shortcutted letters, the system must immediately and confidently output that letter.

## Output Expectations:
1. Provide the UI components for the step-by-step calibration sequence.
2. Implement the mathematical analysis function that correctly calculates how much of a letter can be trimmed before it causes a "collision" with another letter.
3. Show the resulting discoverable shortcuts clearly in the bottom-left output box.
4. Ensure the live prediction engine utilizes these specific shortcuts to drastically reduce the amount of physical drawing the user has to do.
