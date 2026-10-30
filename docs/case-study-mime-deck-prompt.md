# Prompt: build the Mime deck in PowerPoint

**The skill:** `pptx`, from Anthropic's official skills repository, [anthropics/skills](https://github.com/anthropics/skills). At 184,841 stars it's the most-starred skills repository found in a GitHub search on 30 Oct 2026. It builds native, editable decks with pptxgenjs, and comes with scripts to validate them and render thumbnails.

The most-starred diagram skill, [tt-a1i/archify](https://github.com/tt-a1i/archify) (91,541 stars), makes interactive HTML, not slides. That's why the diagrams here are built as native shapes by the pptx skill instead.

**Set up once,** inside Claude Code. These are Claude Code commands, not terminal commands:

```text
/plugin marketplace add anthropics/skills
/plugin install document-skills@anthropic-agent-skills
```

**Then** attach the four reference images and paste this:

```text
Use the pptx skill. Build docs/deck/mime-case-study.pptx from docs/case-study-mime-deck.md: 14 slides, pres.layout = LAYOUT_WIDE (13.333 × 7.5 in). The deck file is the spec: its Visual system, its Placeholders, and each slide's copy, boxes and diagrams. Boxes are px on 1920 × 1080: divide by 144 for inches, and font px × 0.5 = pt. The attached images show the elements to borrow (soft light, a glass shape, corner labels, squircle icons); use them quietly.

Style: clean and modern. White slides, lots of space, Plum #2B1638 text in Inter (else Helvetica Neue). Jelly's colour is about 5% of a slide: the ==marked== headline phrase and stat numbers in Rose #F2618D → Berry #D94886, small squircle icons and diagram highlights in the Jelly gradient, and at most one faint corner glow. Cards only where the deck says; elsewhere hairlines. If a slide looks busy, remove something.

Rules:
- Copy is final, word for word. Add no claims, numbers or quotes.
- Make no images: no mockups, devices, photos, Jelly or backgrounds. Every CAP- and GEN- item is a placeholder card; I'll add the media.
- Everything native and editable. Don't commit.

Build notes:
- pptxgenjs has no gradient fills. Add a:gradFill by editing the slide XML after generation: the accent runs, the squircles, diagram highlights, and the glow as a soft-edged ellipse. If that fails, use solid Berry for text and drop the glow.
- Card: ROUNDED_RECTANGLE (rectRadius for 24 px), Highlight #FFF4EC fill, Plum hairline at 92% transparency, Plum shadow at opacity 0.06, blur 40, offset 12, angle 90.
- Placeholder card at its exact box: Highlight fill, 1.5 px dashed Plum border at 80% transparency, a 48 px squircle with a native white icon (▶ for video, a mountain for photo, a window for screenshot, a sparkle for GEN), then "ID · TYPE", the deck's one-line description, and the ratio. Name each by ID in the Selection Pane, lettering multi-card IDs (CAP-05a to CAP-05d). A capture inside a generated frame is a smaller card inside it.
- Diagrams D-01 to D-08: native shapes and connectors laid out to fit their boxes, from the deck's Mermaid and notes. D-06 is a native bar chart with the Web Worker bar as the only accent.
- Speaker notes: each slide's placeholders, plus the tables the deck sends to the notes.

Check: run the skill's validate.py, render with its soffice wrapper and thumbnail.py, and fix overflow, overlaps, margins and contrast until clean. Confirm 14 slides, every ID placed, and a third of each slide empty. Show me the thumbnail grid and the file path. If anything is missing, give me the install command instead of installing it.
```
