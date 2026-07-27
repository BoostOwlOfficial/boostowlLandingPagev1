# Favicon variants

Two designs of the BoostOwl favicon. Both are generated from
[`../boostowl-logo-primary.svg`](../boostowl-logo-primary.svg) — cream owl on brand deep
teal (`#04302E`), green accents (`#01DC82`).

| File | Design | Status |
|---|---|---|
| `icon-head-only.svg` | Owl head only, no motion lines | ✅ **Currently active** |
| `icon-with-motion-lines.svg` | Full mark — owl + green motion lines | Backup |

**Why head-only is active:** with the motion lines included, the art is 1.65:1, so on a
square icon the owl gets squeezed to ~60% of the width — roughly 10px inside a 16px browser
tab, where it turns muddy. The head-only crop is already square (115×115 in the source), so
the owl fills the icon and stays legible at every size.

The motion lines still appear everywhere they have room: the nav logo, the footer logo, and
`../boostowl-logo-mark.svg`.

---

## Switching variants

Replace `<variant>` with `icon-head-only` or `icon-with-motion-lines`, then run from the
**repo root** (requires ImageMagick):

```bash
# 1. make the chosen variant the active icon
cp assets/favicon-variants/<variant>.svg icon.svg

# 2. strip the rounded corner for iOS (it applies its own mask, else it double-rounds)
sed 's/ rx="[0-9]*"//' icon.svg > .apple-src.svg

# 3. regenerate the rasters
magick -background none icon.svg -resize 512x512 -depth 8 -strip icon-512.png
magick -background none icon.svg -resize 192x192 -depth 8 -strip icon-192.png
magick -background "#04302E" .apple-src.svg -resize 180x180 -alpha remove -alpha off -depth 8 -strip apple-touch-icon.png
magick -background none icon.svg -define icon:auto-resize=48,32,16 favicon.ico
rm .apple-src.svg
```

Generated files (all at the repo root): `icon.svg`, `favicon.ico`, `apple-touch-icon.png`,
`icon-192.png`, `icon-512.png`.

No HTML changes are needed — the `<link>` tags reference these filenames and don't change.

⚠️ **Browsers cache favicons very aggressively** (Chrome keeps a separate favicon database
that a normal cache clear doesn't touch). After switching, hard-reload, or open
`https://www.boostowl.io/favicon.ico` directly and reload that tab. Expect the tab icon to
lag by a few minutes even when the files are correct.

---

## Editing the design

Don't hand-edit these SVGs — they're generated. Change
[`../boostowl-logo-primary.svg`](../boostowl-logo-primary.svg) instead, then re-derive both
variants:

- **head-only** — drop the wordmark path (`fill="#025456"`) and all `<rect>` motion lines,
  set `viewBox="67 9 131 131"`, recolour `#005653` → `#FBF8F1`, add the background rect
- **with-motion-lines** — drop only the wordmark path, set `viewBox="-10 -30.5 210 210"`,
  same recolour and background rect
