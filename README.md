# BoostOwl — Landing Page

Marketing site for **BoostOwl**, the operating system for Indian SMBs delivered through
WhatsApp. Live at **[www.boostowl.io](https://www.boostowl.io)**.

---

## Stack

A deliberately simple **static site** — no framework, no build step, no `package.json`.
Edit the HTML and push; that's the whole workflow.

| Layer | What |
|---|---|
| Markup | Hand-written HTML with inline `<style>` blocks |
| Hosting | **Vercel** (auto-deploys from `main`) |
| CDN / DNS | **Cloudflare** proxies in front of Vercel |
| Serverless | 3 tiny Node functions in `api/` (see below) |
| Analytics | Google Analytics 4 + Microsoft Clarity |

---

## Structure

```
├── index.html              Landing page (inline CSS + JS, ~1500 lines)
├── blog.html               Blog index
├── post.html               Blog post shell — renders markdown client-side
├── 404.html                Custom not-found page
├── legal/
│   ├── privacy.html        Privacy policy (DPDP Act 2023)
│   ├── terms.html          Terms of usage
│   └── data-deletion.html  Data deletion request info
├── api/                    Serverless functions (see "Legal page routing")
├── posts/                  Blog content: *.md + posts.json index
├── assets/                 CSS, JS, images, logo SVGs
├── favicon.ico  icon.svg  apple-touch-icon.png  icon-192.png  icon-512.png
├── manifest.webmanifest    PWA manifest (Android "Add to home screen")
├── robots.txt  sitemap.xml
└── vercel.json             Function config + legal page rewrites
```

### Legal page routing (why `api/` exists)

`/privacy.html`, `/terms.html` and `/data-deletion.html` are **rewritten to serverless
functions** that read the matching file from `legal/` and return it with a full `200`.

This exists because Meta's crawler issued Range requests and got a `206 Partial Content`,
truncating the `<head>` so Open Graph tags were never seen. The functions force a complete
response.

**You still edit `legal/*.html` directly** — the functions serve those files verbatim.

---

## Running locally

No build step, but **serve over HTTP** — opening the file directly (`file://`) breaks
relative paths and analytics.

```bash
python -m http.server 8000
# → http://localhost:8000
```

Note: `/privacy.html` etc. won't route locally (they're Vercel rewrites). Open
`/legal/privacy.html` instead, or use `vercel dev` to test the real routing.

## Deploying

Push to `main` → Vercel builds and deploys automatically. That's it.

---

## Adding a new page — read this first

There is **no shared header or template**. Every page carries its own `<head>`, its own
inline SVG sprite, and its own copy of the analytics + favicon tags.

When you add a page, copy the block from **[`assets/analytics-snippet.html`](assets/analytics-snippet.html)**
into its `<head>` (right after the `viewport` meta). Without it the page is untracked and
shows no favicon.

Also remember to add the new URL to [`sitemap.xml`](sitemap.xml).

---

## Analytics

| Tool | ID | What it gives us |
|---|---|---|
| **Google Analytics 4** | `G-1V2XBVV7WB` | Traffic, sources, campaigns, conversions |
| **Microsoft Clarity** | `xrwvfcen0b` | Heatmaps, session recordings, rage/dead clicks |

Both are free, live on every page, and disclosed in the privacy policy. There is currently
**no cookie banner** — the audience is India-first. If meaningful EU/UK traffic appears,
a consent gate is required before these scripts load.

**These IDs are public by design** (visible in page source) and are not secrets.

**Expect a 10–20% undercount.** Ad blockers and Brave block both tools — Brave even serves
a fake stub for `gtag.js` that returns `200` but records nothing. For a true visitor count,
use Cloudflare's edge analytics, which needs no JavaScript and cannot be blocked.

---

## Brand

| Token | Value |
|---|---|
| Green | `#01DC82` |
| Deep (nav/footer) | `#04302E` |
| Paper | `#FBF8F1` |
| Ink | `#042925` |

**[`assets/boostowl-logo-primary.svg`](assets/boostowl-logo-primary.svg) is the single
source of truth for the logo.** It's inlined into each page's SVG sprite as `#i-logo` with
the dark shapes set to `currentColor`, so the logo automatically renders white on the dark
nav and footer. All favicon files are generated from it.

`assets/boostowl-logo-mark.svg` is the owl + motion lines without the wordmark (standalone
asset, keeps the original brand teal — use it for decks, email, social avatars).

**Favicon** is currently the **owl head only**, without motion lines — the full mark is
1.65:1, so it turns muddy at 16px in a browser tab. The motion-lines version is kept as a
backup and can be restored in one command: see
[`assets/favicon-variants/README.md`](assets/favicon-variants/README.md).

---

## Social

- Instagram — https://www.instagram.com/boostowl.io/
- X — https://x.com/boostowlio
- Threads — https://www.threads.com/@boostowl.io
- LinkedIn — https://www.linkedin.com/company/boostowl/

---

## Known gaps / next up

- **Blog posts have no crawlable meta.** `post.html` sets its title and OG tags in
  JavaScript, and crawlers don't run JS — so shared post links preview as
  *"Loading… — BoostOwl Blog"*. Fix: server-render per-post meta via the `api/` pattern.
- No security headers in `vercel.json` (CSP, HSTS, `X-Content-Type-Options`).
- No `:focus-visible` styles, no `<main>` landmark, no skip link — accessibility gaps.
- Screenshots in `assets/` are PNG only; WebP/AVIF would cut page weight substantially.
- No `www` → apex (or vice versa) redirect enforced; canonicals currently declare `www`.
