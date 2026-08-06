---
name: CareerPilot CN
description: A calm, evidence-first application desk for Chinese campus recruitment.
colors:
  brand-orange: "#dd7627"
  brand-orange-hover: "#ffa333"
  brand-ink: "#281d15"
  brand-text: "#a54f12"
  canvas-light: "#f7f6f3"
  surface-light: "#ffffff"
  surface-hover-light: "#efeeea"
  border-light: "#dfdcd8"
  ink-light: "#1f1c19"
  muted-light: "#5f584f"
  faint-light: "#736c64"
  editorial-olive: "#59592a"
  canvas-dark: "#0a0a0a"
  surface-dark: "#161616"
  surface-hover-dark: "#232323"
  border-dark: "#262626"
  ink-dark: "#fafafa"
  muted-dark: "#a1a1aa"
  faint-dark: "#8b8b95"
typography:
  display:
    fontFamily: "Instrument Serif, Georgia, serif"
    fontSize: "2rem"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.brand-orange}"
    textColor: "{colors.brand-ink}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.brand-orange-hover}"
    textColor: "{colors.brand-ink}"
  button-secondary:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  field:
    backgroundColor: "{colors.canvas-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  container:
    backgroundColor: "{colors.surface-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: CareerPilot CN

## 1. Overview

**Creative North Star: "可信投递台"**

CareerPilot CN should resemble a well-organized desk at the moment a candidate makes a consequential decision: the evidence is within reach, the current state is obvious, and the next action is deliberate. The application shell stays restrained so dense qualification, Fact, Campaign, and export information can carry the attention.

The interface rejects generic overseas ATS dashboards, flashy startup landing pages, “one-click mass apply” theater, and resume galleries whose thumbnails are disconnected from real output. Visual confidence comes from exact hierarchy, alignment, state language, and verified artifact previews rather than decoration.

**Key Characteristics:**

- Warm neutral work surface with one burnt-orange action accent.
- Compact but readable Chinese-first information hierarchy.
- Flat surfaces separated primarily by tone and precise borders.
- Real-state feedback for pending, blocked, stale, confirmed, and verified artifacts.
- Resume previews may adopt their selected document palette without recoloring the application shell.

## 2. Colors

The application uses a restrained warm-neutral palette; burnt orange is rare and functional, while resume documents own their separate, print-safe theme colors.

### Primary

- **Action Orange:** reserved for the primary action, current selection, progress, and focus-worthy state.
- **Readable Brand Text:** a darker orange used for small text on light surfaces where the raw accent would fail contrast.

### Secondary

- **Editorial Olive:** limited to high-level editorial headings outside dense task controls.

### Neutral

- **Warm Canvas and White Surface:** establish the local workbench and its document-like content planes.
- **Warm Ink, Muted, and Faint:** form a three-step readable text hierarchy without low-contrast gray.
- **Dark Canvas and Layered Charcoal:** preserve the same hierarchy in dark mode rather than introducing a separate neon identity.

**The One Action Color Rule.** Burnt orange marks action or current state; it never becomes decorative wallpaper.

**The Artifact Independence Rule.** A blue or red resume theme appears inside its preview and export only. It does not recolor Campaign, Fact, or application controls.

## 3. Typography

**Display Font:** Instrument Serif (with Georgia fallback)

**Body Font:** Inter (with system UI fallback)
**Label/Mono Font:** system monospace for hashes, IDs, and machine-readable diagnostics

**Character:** Inter carries the task interface with familiar, compact clarity. Instrument Serif is an editorial accent for a small number of page-level or report headings, never for controls, data, or dense workflow labels.

### Hierarchy

- **Display** (400, 2rem, 1.15): selected editorial headings only.
- **Headline** (600, 1.5rem, 1.25): page and workspace titles.
- **Title** (600, 1rem, 1.4): panels, artifact names, and major control groups.
- **Body** (400, 0.95rem, 1.7): explanations and evidence text; prose is capped near 75 characters where practical.
- **Label** (600, 0.75rem, 1.4): field labels, states, and compact metadata; uppercase is exceptional rather than a repeated scaffold.

**The Task-Type Rule.** Inter is mandatory for buttons, inputs, tables, filters, and state labels. Display typography never enters a control.

## 4. Elevation

The system is flat by default. Depth comes from the canvas-to-surface tonal step, 1px borders, and state changes. Wide decorative shadows are prohibited; a focused popover may use a compact structural shadow only when it must separate from content below.

**The Flat-at-Rest Rule.** A resting card or control uses either a border or a compact shadow, never both as decoration.

## 5. Components

Components are familiar, restrained, and complete across default, hover, focus-visible, active, disabled, loading, and error states.

### Buttons

- **Shape:** gently squared corners (6px).
- **Primary:** Action Orange with Brand Ink and 8px by 16px padding.
- **Hover / Focus:** hover shifts to the lighter orange; focus remains clearly visible and is never color-only.
- **Secondary / Ghost:** neutral surface or transparent treatment with a precise border; identical height and radius to the primary button.

### Chips

- **Style:** pill geometry is reserved for short statuses, counts, and filters.
- **State:** selected chips use a restrained tinted background and explicit label; status must remain understandable without hue.

### Cards / Containers

- **Corner Style:** 12px for major work areas, 8px for nested records.
- **Background:** a single surface step over the canvas.
- **Shadow Strategy:** flat at rest.
- **Border:** one precise neutral border where containment is necessary.
- **Internal Padding:** 16px to 20px, reduced only for dense repeated rows.

### Inputs / Fields

- **Style:** 6px radius, neutral border, canvas background, and 8px by 12px padding.
- **Focus:** visible outline or border shift with sufficient contrast.
- **Error / Disabled:** pair visual treatment with plain-language state text; disabled controls preserve readable labels.

### Navigation

Navigation uses Inter, restrained neutral states, and one active indicator. Mobile behavior collapses structure rather than shrinking typography.

### Resume Style Selector

Each style is represented by a real A4 preview, a concise fit explanation, and explicit axes for theme, photo, density, and page budget. Recommendation badges explain their evidence and never prevent manual selection. Comparison keeps the same anonymous content across styles so the visual differences are honest.

## 6. Do's and Don'ts

### Do:

- **Do** show the real pending, blocked, stale, confirmed, or verified state beside the affected artifact.
- **Do** use Action Orange only for primary action, selection, progress, or focus.
- **Do** render resume thumbnails from the same normalized content model used by DOCX/PDF.
- **Do** keep Chinese body text readable under common Windows scaling and preserve keyboard focus.
- **Do** keep candidate references private and use anonymous fixtures in shared tests and previews.

### Don't:

- **Don't** imitate generic overseas ATS dashboards that hide decisions behind an unexplained percentage.
- **Don't** use flashy startup landing pages, neon AI gradients, glassmorphism, or decorative automation theater.
- **Don't** present “one-click mass apply” growth hacks or submission volume as success.
- **Don't** build resume-template galleries whose mockups hide pagination, text layer, Fact traceability, or export differences.
- **Don't** treat social-media resume examples as candidate facts, certified recruiter truth, or verbatim templates.
- **Don't** use a colored side stripe wider than 1px, gradient text, decorative grid backgrounds, or a wide ghost-card shadow.
