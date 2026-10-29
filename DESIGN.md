---
name: เข็มทิศฟุตบอล (Khemthit Football)
description: วิเคราะห์บอลวันนี้ ด้วยข้อมูลจริง — a light, scoreboard-first Thai football analysis site.
colors:
  ink: "#0b1324"
  ink-raised: "#15203a"
  canvas: "#ffffff"
  pitch: "#0f766e"
  pitch-bright: "#2dd4bf"
  pitch-soft: "#ccfbf1"
  compass: "#b45309"
  compass-soft: "#fef3c7"
  compass-bright: "#fbbf24"
  compass-ring: "#d97706"
  live: "#e11d48"
  live-text: "#be123c"
typography:
  display:
    fontFamily: "IBM Plex Sans Thai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.375
  title:
    fontFamily: "IBM Plex Sans Thai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: 1.375
  body:
    fontFamily: "IBM Plex Sans Thai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "IBM Plex Sans Thai, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.375
    fontFeature: "'tnum' 1"
rounded:
  card: "12px"
  section: "16px"
  pill: "9999px"
spacing:
  gutter: "16px"
  row-gap: "6px"
  tabbar: "4rem"
components:
  match-card:
    backgroundColor: "#f8fafc"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "8px 6px 8px 8px"
    height: "56px"
  match-card-signal:
    backgroundColor: "{colors.compass-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  date-chip-selected:
    backgroundColor: "{colors.pitch-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    height: "44px"
  live-chip:
    backgroundColor: "{colors.live}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.pill}"
    height: "44px"
---

# Design System: เข็มทิศฟุตบอล

## Overview

**Creative North Star: "The Match-Night Scoreboard"** *(provisional wording, written from the shipped code and PRODUCT.md; confirm or rename)*

A fan on a phone, shortly before kickoff, wants the night's matches in seconds, then one honest signal or none. The site is a bright, quiet scoreboard: white canvas, pale-grey match cards, a single teal accent for navigation and selection, and a warm amber reserved for the one thing that is the brand's own, the เข็มทิศเกม signal. Density is high but calm; nothing decorates, everything is a score, a time, a team or a verdict.

The look is livescore-literate on purpose (the reader already knows the pattern) and gets its identity from restraint and from the amber compass row, never from ornament. It does not read as a betting tip sheet: no loud red/gold promotions, no odds-first layouts, no urgency chrome.

**Key Characteristics:**
- Light theme only. White canvas, `ink` text, slate neutrals; no dark mode.
- One teal accent (`pitch`) for links, selected day, active nav, data bars.
- One warm accent (`compass`) used only for signal rows and the compass emblem.
- Football-day grouping (06:00 to 06:00 Thai) with "เช้ามืด…" dividers; live first, then upcoming, then finished.
- Thai-first type: IBM Plex Sans Thai, tabular numerals, generous line height.

## Colors

A neutral light base with two meaningful accents; colour always carries a meaning (selected, signal, live), never decoration.

### Primary
- **Pitch Teal** (#0f766e): links, selected/active navigation, league ring, section markers, data bars. 5.4:1 on white.
- **Pitch Mint** (#ccfbf1): the selected date chip and selected league tile background.
- **Pitch Bright** (#2dd4bf): the teal on dark chrome only (footer, focus ring on dark).

### Secondary
- **Compass Amber** (#b45309): signal text and the compass tab. 5.0:1 on white.
- **Compass Cream** (#fef3c7): the tint behind a signal row (used at 40%).
- **Compass Ring** (#d97706): the 2px ring around a signal row; 3.2:1 on white so the boundary passes non-text contrast.
- **Compass Bright** (#fbbf24): amber on dark chrome only.

### Tertiary
- **Live Rose** (#e11d48): live dot, LIVE chip fill (white text 4.7:1).
- **Live Text Rose** (#be123c): live minute and live labels on light surfaces (6:1).

### Neutral
- **Ink** (#0b1324): text, footer chrome, skip link.
- **Canvas** (#ffffff): page background.
- **Slate scale** (Tailwind slate 50 to 600): card fill (50), hairlines (200), secondary text (600, 7.6:1 on white; 500 only where the background is white).

### Named Rules
**The Two Voices Rule.** Teal means "where you are or can go"; amber means "this match has a signal". They never swap roles and never share a surface.

**The Contrast Floor Rule.** Informational text is at least 4.5:1, a boundary that carries meaning is at least 3:1. slate-400 is for nothing the reader needs.

## Typography

**Display / Body / Label Font:** IBM Plex Sans Thai (weights 400, 500, 600, 700; latin + thai subsets, self-hosted via next/font, `display: swap`), falling back to `ui-sans-serif, system-ui`.

**Character:** a neutral, data-friendly humanist sans with real Thai stacks and tone marks; the personality comes from weight steps and numerals, not from a display face.

### Hierarchy
- **Display** (700, 1rem, 1.375): page and band headings ("แมตช์วันนี้"); the site has no large hero type.
- **Title** (700, 0.875rem, 1.375): league names, section headings.
- **Body** (400 to 600, 0.875rem, 1.5): team names, previews; the winner is 600, the loser slate-600.
- **Label** (600, 13px, 1.375, tabular numerals): status, counts, dates, dividers. 13px is the floor for anything informational; 12px is not used for content.

### Named Rules
**The Thai Line-Height Rule.** Never `leading-none`/`leading-tight` on Thai text; use `leading-snug` or looser so stacked vowels and tone marks are not clipped.

**The Tabular Rule.** `font-feature-settings: 'tnum'` is on globally so times, scores and odds align.

## Layout

A single centred column (`max-w-3xl`) with 16px gutters on phones; from `lg` the scoreboard band widens to `max-w-5xl` and a 300px sidebar (league picker, standings, top scorers) sits beside the day's matches, sticky below the date strip. On phones the sidebar content falls below the previews. The date strip (LIVE, five days, calendar) is sticky under the 56px/64px header; a fixed five-item bottom tab bar (4rem plus safe area) carries navigation with the compass raised in the middle.

Rhythm: 6px between match cards, 20px between league groups, 32px between page sections. Rows are at least 56px, every tap target at least 44px.

## Elevation & Depth

Flat by default. Depth comes from tone (slate-50 cards on white, hairline slate-200 borders, 1px inset rings), not shadows. The only shadow is the raised compass button in the mobile tab bar. Sticky bars use a translucent white with a light backdrop blur so content scrolls beneath them legibly.

### Named Rules
**The Flat-By-Default Rule.** Cards have no shadow at rest or on hover; hover changes tone only.

## Shapes

Soft but not playful: match cards and date chips use 12px radius, section panels 16px, chips/pills and badges are fully round. League badges are a 32px circle with a 2px teal ring around a white disc so dark logos stay readable. Team and league logos are 18px square, `object-contain`.

## Components

### Match Card
A full-row link: 44px status column (kickoff time, live minute, or จบ), a hairline divider, two team lines (logo, name, score), and a right-hand marker. Fill slate-50 with a 1px slate ring; a signal row uses compass-cream at 40% with a 2px compass-ring and shows the compass emblem (pending) or the ถูก/ผิด result pill (finished). The winner is bold, the loser slate-600. A screen-reader-only line states the score.

### Date Strip
Sticky nav of a LIVE chip, five day chips (weekday over date) and a calendar button, all 44px high. The selected day is pitch-mint with ink text; today unselected is teal text; LIVE is rose-filled only when selected.

### League Header
Teal-ringed 32px logo disc, league name (700) with country beneath, match count right-aligned.

### Section Panel
White, 16px radius, 1px slate-200 border, 16 to 20px padding, bold heading with an optional right-aligned aside.

### Focus
A global 2px pitch outline with 2px offset on every interactive element, never removed; on dark chrome it switches to pitch-bright. The outline follows the element's own shape.

## Do's and Don'ts

### Do
- Keep fan-facing pages to picks only; the 🌫️ no-signal state lives on /performance and admin.
- Mark the เข็มทิศเกม feature with the compass emblem image, and explain it once near where it first appears.
- Show losses and half results exactly as plainly as wins.
- Put a Thai label of at least 13px and a 44px target on anything tappable.

### Don't
- Don't use the 🧭 🔎 📊 emoji in headings, labels or copy.
- Don't add a kicker or eyebrow above a heading, gradient text, or a coloured side-stripe on cards.
- Don't introduce a new accent colour or a dark theme without an owner decision; redesigns stay inside this look.
- Don't use gambling vocabulary (ทีเด็ด, แทง, กำไร, การันตี) or promotional urgency.
- Don't use slate-400 for readable text or an amber ring lighter than #d97706 as the only boundary.
