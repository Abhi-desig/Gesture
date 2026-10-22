# Claude Design prompt

Paste everything inside the block into Claude Design, and attach three files: **CASE-STUDY-DECK.md**, **reference 1** (the GrowSphere landing page) and **reference 2** (the glass "Rooms" dashboard).

Fill in the self-test numbers on slide 21 of the deck first.

```
Design a 26-slide case study deck, 16:9 at 1920×1080, for an AI creative technologist portfolio. The audience is hiring managers at design-technology studios and AI product teams. It should read like an R&D lab's project review: precise, measured, confident. Not playful.

SOURCE OF TRUTH
CASE-STUDY-DECK.md has the order, copy and layout for every slide. Use its Eyebrow, Headline, Subhead, Body, Pull line, Footer, Callouts and table text word for word. Don't add, rewrite or pad copy. Its "Visual" and "Source" lines are instructions for you, not slide text. Skip the "Short version" and "Visual checklist" sections.
Any "__" left in the deck is a number still to be measured. Show it as an empty mono field. Never invent a number.

STYLE: COMBINE THE TWO REFERENCES
Reference 1 (GrowSphere) sets the typography, colour and rhythm: crisp white canvases, electric-blue sections with a fluid 3D wave, very large light-weight headlines, lots of whitespace, hairline dividers, pill-shaped tags, big light numbers, and one glossy chrome or glass 3D object as an accent.
Reference 2 (Rooms) sets the cards: frosted glass tiles over a rich background, very rounded corners, title top-left, meta row along the bottom, round count pills, floating pill notifications and segmented controls.

COLOUR (approximate)
Electric blue #1438F5 · Deep navy #0B1A7A · White #FFFFFF · Cool off-white #F4F6FB · Ink #0E1016 · Grey #6B7280 · Hairline #E3E7F0 · Accent green #1FA971 · Error red #E5484D
Use green once per slide at most, for the single highlight: the wrist, the winning row, the key number. Use red only for failed results.

TYPE
One light grotesk throughout, like Neue Montreal or Helvetica Now Display. Google fallback: Inter Tight. Use a monospace face (JetBrains Mono or similar) only for code, log lines, numbers in tables and small technical labels.
Headline 96px Light, -2% tracking · Section headline 64px Light · Body 28px Regular, 1.4 line height · Eyebrow 18px Medium in a pill tag · Stat numbers 140px Light · Captions 18px grey · Mono labels 18px.
At most two weights per slide. Never bold headlines.

GRID
96px outer margins, 12 columns, 24px gutters. Keep the eyebrow and headline in the same position on every slide.
Radius: 32px for image frames and panels, 36px for glass cards, fully round for pills.

GLASS CARD (from reference 2)
White at 55–65% opacity, 40px background blur, 1px inside border in white at 60%, shadow 0 24 64 rgba(14,24,80,0.14), 32px padding.
Title top-left 32px Regular in ink, subtitle 20px grey, meta row at the bottom.
Glass only works with something behind it, so use it only over a photo or the blue wave. On white slides, use solid white cards with a hairline border.
Use the segmented-control pattern for Before / After on slide 13. Use floating numbered pills for the five interface callouts on slide 10, and floating pills for small technical callouts such as "62.5 / s", "0.11 / 0.18" or "armed".

THE LANDMARK MOTIF
The project's signature is a hand drawn as 21 landmarks.
On white slides: electric-blue lines and navy dots. On blue slides: white lines and dots with a soft glow. The wrist (landmark 0) is always green.
On slide 6 only, make it the 3D hero: 21 glossy glass beads joined by thin chrome tubes, floating the way the infinity object does in reference 1, with small mono index labels 0–20.
Draw landmark sketches precisely, like technical diagrams, never as cartoon hands.

SLIDE TYPES
A · Photo + glass card: slides 1, 3, 23. Full-bleed image placeholder, text inside frosted glass cards.
B · White editorial: slides 4, 5, 6, 7, 9, 10, 11, 14, 15, 17, 20, 21. White canvas, light headline, hairline tables, small glossy 3D icons where the deck asks for icons.
C · Electric blue: slides 2, 12, 16, 18, 22, 24, 26. Blue fluid-wave background, white type. The chart, log, sound cues and stats sit in glass cards or as big white numbers, like the stats band in reference 1.
D · Glass tile grid: slides 8, 13, 19, 25. Glass tiles over the blue wave, laid out like the room grid in reference 2.

PLACEHOLDERS
Every [TYPE] in the deck becomes a rounded frame that keeps that slide's layout split. Use an off-white fill on white slides and frosted glass on blue ones. Put a pill label at top-left (for example "PHOTO · Desk, notebook, displays") and the deck's description in 18px grey, centred.
Don't generate photos of people or fake screenshots.

DATA
- Slide 9: draw the 4 × 4 distance matrix of fist, pinch, open palm and swipe shape from the deck's numbers (0.20, 0.27, and 0.46–0.56 for the rest), with the two close pairs highlighted.
- Slide 12: draw the bar chart to scale from the deck's numbers (0, 0, 1.5, 1.5, 62.5), with the Web Worker bar in green.
- Slide 15: failures are red, partial results grey and System Events green.
- Slide 17: draw the two timelines from the same switch, a flat line for the Dock cache and a step for the window server.
- Slide 18: draw each sound cue as notes on a thin pitch line: two rising dots, two falling dots, one short dot, an empty line.
- Slide 19: the Match panel shows a distance meter with the 0.18 threshold marked, a re-made gesture at 0.05–0.09 and one finger off at 0.25+.
- Slide 21: show the results exactly as written, weak ones included.

AVOID
Purple gradients, neon, text shadows, more than one 3D object per slide, glass on plain white, emoji, cartoon or illustrated hands, stock "AI brain" imagery, centred body text, and any copy that isn't in the deck.

DELIVER
All 26 slides in order, with editable text. Then list slides 1, 2, 3, 5, 7, 9, 10, 12, 15, 17, 18, 19, 21, 22, 24 and 26 as the short version.
```
