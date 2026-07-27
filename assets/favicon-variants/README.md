# Favicon

Generated from [`../boostowl-logo-primary.svg`](../boostowl-logo-primary.svg) — the owl head
only (no motion lines), since the full mark is 1.65:1 and turns muddy at 16px.

## The active icon adapts to the browser theme

`/icon.svg` carries a `prefers-color-scheme` media query, so the tab icon inverts with the
browser theme:

| | Plate | Owl | Eyes |
|---|---|---|---|
| **Light mode** (base styles) | `#FBF8F1` cream | `#04302E` deep teal | `#01DC82` |
| **Dark mode** (`@media` override) | `#04302E` deep teal | `#FBF8F1` cream | `#01DC82` |

Shapes carry `class="plate|owl|eye"`. The `fill=""` attributes duplicate the **light/base**
values so any renderer that ignores embedded CSS still emits the correct light-mode icon —
CSS beats presentation attributes, so the media query wins where it's supported.

### Which browsers actually adapt

| Context | Serves | Adapts? |
|---|---|---|
| Chrome / Edge / Firefox | `icon.svg` | ✅ **on page load** — needs a reload after switching theme |
| Safari 26+ | `icon.svg` | ❌ renders base (light) — [WebKit bug 309949](https://bugs.webkit.org/show_bug.cgi?id=309949), still open |
| Safari ≤18.7, IE | `favicon.ico` | ❌ static (no SVG favicon support before Safari 26) |
| Google Search, Slack unfurls, bookmarks | `favicon.ico` | ❌ static |

This is safe **progressive enhancement**: unsupported contexts fall back to a legible icon
(dark plate measures 12.9:1 on light chrome; cream owl 11.4:1 on dark chrome). Nothing breaks.

> ⚠️ **Never use two `<link rel="icon" media="...">` tags.** Firefox doesn't support `media`
> on favicons ([bug 1603885](https://bugzilla.mozilla.org/show_bug.cgi?id=1603885), open since
> 2019), and the HTML spec then says *"use the last one declared in tree order"* — so Firefox
> would serve the **dark** icon to light-mode users. That's a regression, not a fallback.
> The in-SVG media query is the only technique that degrades safely.

## Raster files stay on the dark design — on purpose

`.ico` and `.png` are static raster formats; they **cannot** carry a media query. They keep the
dark badge because they're mostly consumed on white surfaces (Google Search, Slack, bookmarks)
and on the iOS home screen, where the dark plate is strongest and most recognisable.

| File | Design |
|---|---|
| `favicon.ico` (16/32/48) · `icon-192.png` · `icon-512.png` · `apple-touch-icon.png` | dark plate, cream owl |

## Variants kept for reference

| File | Design | Status |
|---|---|---|
| `icon-head-only.svg` | Owl head, no motion lines | Basis of the active `/icon.svg` |
| `icon-with-motion-lines.svg` | Full mark incl. motion lines | Backup — rejected, muddy at 16px |

## Regenerating the rasters

⚠️ **ImageMagick ignores the embedded CSS**, so it renders the `fill=""` attributes — i.e. the
**light** design. To regenerate the dark rasters, render from `icon-head-only.svg` (which has
the dark plate hard-coded), not from `/icon.svg`:

```bash
sed 's/ rx="[0-9]*"//' assets/favicon-variants/icon-head-only.svg > .apple-src.svg
magick -background none assets/favicon-variants/icon-head-only.svg -resize 512x512 -depth 8 -strip icon-512.png
magick -background none assets/favicon-variants/icon-head-only.svg -resize 192x192 -depth 8 -strip icon-192.png
magick -background "#04302E" .apple-src.svg -resize 180x180 -alpha remove -alpha off -depth 8 -strip apple-touch-icon.png
magick -background none assets/favicon-variants/icon-head-only.svg -define icon:auto-resize=48,32,16 favicon.ico
rm .apple-src.svg
```

*(`rx` is stripped for apple-touch because iOS applies its own squircle mask — pre-rounded
corners would double-round.)*

## Testing

Browsers cache favicons in a **separate store that a hard refresh does not clear** (Chrome uses
its own SQLite DB). To see a change:

1. Use an **Incognito window** — most reliable.
2. Or append a cache-buster: `href="/icon.svg?v=2"`.
3. Or open `https://www.boostowl.io/icon.svg` directly and reload that tab.

To test dark mode: **switch the OS theme, then reload the page.** The media query is evaluated
once at load, so flipping the theme with the tab already open will not repaint the icon. That's
a browser limitation affecting every approach except JavaScript swapping.

## Editing the design

Don't hand-edit these — change [`../boostowl-logo-primary.svg`](../boostowl-logo-primary.svg)
and re-derive. Head-only crop is `viewBox="67 9 131 131"`; the full mark is
`viewBox="-10 -30.5 210 210"`. Recolour `#005653` → the plate/owl values and add the background
rect.
