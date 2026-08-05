# ⛔ PROTECTED ROUTES — DO NOT BREAK

These routes exist because **Meta's crawler could not read our legal pages**, which blocks
WhatsApp Business API / Meta app verification. The fix is live and working. This file records
exactly what is load-bearing so it does not get undone by a refactor, a cleanup, or an
accidental edit.

Fixed in `092774a` — *"Route terms.html through serverless function to fix 206 + add OG tags"*.

Not deployed (listed in `.vercelignore`), so this file is internal only.

---

## The bug, and why the fix looks odd

Meta's scraper sends a `Range` header. Vercel's static file server honours it and replies
**`206 Partial Content`** with only the first slice of the file — usually just the `<head>`.
The scraper saw a truncated document, could not confirm the legal pages existed, and
verification failed.

The fix routes those pages through serverless functions instead. A function returns the
**whole document as a plain `200`**, ignoring `Range` entirely.

That is why [api/terms.js](api/terms.js) reads the file with `fs` and calls `res.status(200).send(html)`
rather than letting Vercel serve `legal/terms.html` directly. **It is not redundant. Do not
"simplify" it back to a static file or a redirect.**

---

## The protected set

Changing anything below can break Meta verification.

### Functions — do not edit, rename, move, or delete

| File | Serves |
|---|---|
| [api/terms.js](api/terms.js) | `legal/terms.html` |
| [api/privacy.js](api/privacy.js) | `legal/privacy.html` |
| [api/data-deletion.js](api/data-deletion.js) | `legal/data-deletion.html` |
| [api/post.js](api/post.js) | `post.html` + `posts/**` (blog, not Meta-critical, same mechanism) |

### Content files — do not move or rename

```
legal/terms.html
legal/privacy.html
legal/data-deletion.html
post.html
posts/**
```

You may freely **edit the contents** of the legal pages. Do not change their paths — the
`includeFiles` globs in `vercel.json` point at them.

### `vercel.json` — add to these arrays, never replace them

```json
{
  "functions": {
    "api/privacy.js":       { "includeFiles": "legal/**" },
    "api/data-deletion.js":  { "includeFiles": "legal/**" },
    "api/terms.js":         { "includeFiles": "legal/**" },
    "api/post.js":          { "includeFiles": "{post.html,posts/**}" }
  },
  "rewrites": [
    { "source": "/privacy.html",       "destination": "/api/privacy" },
    { "source": "/data-deletion.html", "destination": "/api/data-deletion" },
    { "source": "/terms.html",         "destination": "/api/terms" },
    { "source": "/blog/:slug",         "destination": "/api/post?slug=:slug" }
  ]
}
```

`vercel.json` is strict JSON and **cannot hold comments** — that is why this file exists.

⚠️ `rewrites` is order-sensitive. A new rule whose `source` matches `/terms.html`,
`/privacy.html`, `/data-deletion.html` or `/blog/*` placed **above** these will shadow them.
Append new rules to the end.

### `.vercelignore` — never ignore these

```
legal/          needed by terms.js, privacy.js, data-deletion.js
post.html       needed by post.js
posts/          needed by post.js
```

A function can only bundle files that were uploaded. Ignoring any of the above breaks the
route silently — the deploy succeeds and the page 500s. **Never use a broad `*.md` pattern**;
it would swallow `posts/*.md`.

---

## Verify after every deploy

```bash
./scripts/verify-routes.sh
```

It asserts each protected URL returns `200` (never `206`), a complete document, and intact
OG tags — including under the exact `Range` header that caused the original bug.

Run it after any change to `vercel.json`, `.vercelignore`, `api/`, or `legal/`.

Manual re-check when it matters:
[Meta Sharing Debugger](https://developers.facebook.com/tools/debug/) → paste
`https://www.boostowl.io/terms.html` → **Scrape Again**.

---

## Careers portal — kept separate on purpose

New careers functions live under **`api/careers/`**, one directory down from the protected
files, so there is no chance of an accidental edit in the wrong file.

```
api/
├── terms.js            ⛔ protected
├── privacy.js          ⛔ protected
├── data-deletion.js    ⛔ protected
├── post.js             ⛔ protected
└── careers/            ✅ safe to edit
    ├── jobs.js
    ├── apply.js
    └── cron/
        ├── score.js
        ├── notify.js
        └── maintenance.js
```

The careers work adds `rewrites` entries (appended, never replacing) and needs **no**
`includeFiles` — it reads from Supabase, not from disk. The protected block above stays
byte-identical.
