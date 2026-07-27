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

### Serverless routing (why `api/` exists)

Four routes are **rewritten to serverless functions** (see [`vercel.json`](vercel.json)):

| URL | Function | Why |
|---|---|---|
| `/privacy.html` `/terms.html` `/data-deletion.html` | `api/privacy.js` etc. | Meta's crawler sent Range requests and got a `206 Partial Content`, truncating the `<head>` so OG tags were never seen. These force a complete `200`. |
| **`/blog/<slug>`** | **`api/post.js`** | Injects the real per-post `<title>` / OG / JSON-LD into the `post.html` shell **before** it reaches the browser, so social scrapers (which don't run JS) get correct previews. |

**You still edit `legal/*.html` and `post.html` directly** — the functions read those files and
only swap the `<head>`.

⚠️ **`post.html` must use absolute asset paths** (`/assets/…`, `/index.html`). It's served at
`/blog/<slug>`, so a relative `assets/blog.js` would resolve to `/blog/assets/blog.js` and 404,
breaking the whole page.

Old `post.html?slug=<slug>` links still work — [`assets/blog.js`](assets/blog.js) reads the slug
from either the path or the query string.

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

### 🟡 Blog post bodies are still client-rendered

**Fixed:** social previews and post URLs. [`api/post.js`](api/post.js) now serves posts at
**`/blog/<slug>`** with the real `<title>`, description, canonical, Open Graph, Twitter card
and `BlogPosting` JSON-LD injected **server-side** — so WhatsApp/LinkedIn/X scrapers (which
never run JavaScript) get correct previews. Posts are in `sitemap.xml`, and unknown slugs
return a proper 404.

**Still outstanding:** the post **body** is markdown parsed in the browser (`marked` from a
CDN, [`assets/blog.js`](assets/blog.js)). Google renders JS, but on a deferred queue, so post
*content* is indexed late. The `<head>` is correct, which is what social sharing needs.

Full server-rendering of the body needs a markdown parser in the function, which means adding
`package.json` + a dependency to a repo that deliberately has no build step. Deferred on
purpose. The clean fix is the **Astro migration** below, which also renders bodies at build
time and drops `marked` from the client entirely.

> ⚠️ **New posts:** add the URL to [`sitemap.xml`](sitemap.xml) by hand — it's static.

### 🟡 Nav, footer and SVG sprite are duplicated across all pages

Every change means editing 6+ files. (Verified no page is currently *missing* an icon it uses,
so this is a maintenance hazard, not a live bug.)

**Fix: migrate to Astro (~13–18 h).** Existing HTML/CSS ports mostly as-is, `posts/*.md`
becomes a content collection, the sitemap auto-generates, and less JS ships than today.
Worth doing once the blog is published to regularly.

⚠️ If migrating: `/privacy.html`, `/terms.html`, `/blog.html` and `/blog/<slug>` are indexed —
**preserve those paths or add 301s**, and don't delete the `api/*.js` functions until the Meta
206 fix is re-verified with the Facebook Sharing Debugger.

### Other

- **Nav, footer and the SVG sprite are duplicated across all pages** — every change means
  editing 6+ files. (Verified no page is currently *missing* an icon it uses, so this is a
  maintenance hazard rather than a live bug.) Fixed by the Astro option above.
- No security headers in `vercel.json` (CSP, HSTS, `X-Content-Type-Options`).
- No `:focus-visible` styles, no `<main>` landmark, no skip link — accessibility gaps.
- Screenshots in `assets/` are PNG only (`inbox.png` is 481 KB); WebP/AVIF would cut page
  weight substantially. Cloudflare RUM shows LCP P75 ≈ 2.1 s and P90 ≈ 3.3 s — close to
  Google's 2.5 s threshold, so this is worth doing.
- No `www` → apex (or vice versa) redirect enforced; canonicals currently declare `www`.
- `uploads/` holds ~4.5 MB of unreferenced screenshots still shipping in the deploy.
