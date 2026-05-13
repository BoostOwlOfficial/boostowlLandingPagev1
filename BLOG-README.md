# BoostOwl Blog — how to add a new post

This is the world's simplest CMS: two files per post and you're done.

## File layout

```
posts/
├── posts.json              ← manifest (metadata for every post)
├── _template.md            ← copy this when starting a new post
├── welcome-to-the-boostowl-blog.md
├── apex-sports-ground-case-study.md
└── whatsapp-business-api-explained.md
```

## Adding a new post (3 minutes)

### 1. Create the Markdown file

Copy `posts/_template.md` to `posts/<your-slug>.md`.

The slug is the URL-safe identifier for your post — lowercase, hyphens, no spaces. Examples:

- ✅ `building-our-first-chatbot.md`
- ✅ `q1-2026-update.md`
- ❌ `Building Our First Chatbot.md` (no spaces or caps)

Write your post in Markdown. The first H1 is **not** rendered — the title comes from `posts.json`.

### 2. Add an entry to `posts.json`

Open `posts/posts.json` and add an object to the `posts` array. The entry must come **before** the existing posts if you want it to be the most recent. (Date sort handles ordering, but cleanliness counts.)

```json
{
  "slug": "your-slug",
  "title": "Your post title",
  "excerpt": "One or two sentences. This shows on the blog index card and as the meta description for SEO.",
  "date": "2026-05-15",
  "author": {
    "name": "Mayank",
    "role": "Co-founder, BoostOwl"
  },
  "tags": ["Case studies"],
  "cover": {
    "label": "Your cover label",
    "color": "mint"
  },
  "readingTime": 4
}
```

### 3. That's it

Refresh `blog.html`. Your post appears in the grid. Click it — `post.html?slug=your-slug` renders the Markdown.

---

## Field reference

| Field | Required | Notes |
|---|---|---|
| `slug` | **Yes** | Must match the `.md` filename exactly (without `.md`). |
| `title` | **Yes** | Post title. Renders as H1 on the post page and in cards. |
| `excerpt` | **Yes** | 1–2 sentences. Shows on cards + becomes the meta description (SEO). |
| `date` | **Yes** | ISO format: `YYYY-MM-DD`. Posts are sorted newest first. |
| `author.name` | **Yes** | Display name. Generates the avatar initials. |
| `author.role` | No | Sub-label under the name on the post page. |
| `tags` | No | Array of strings. Used for the filter chips on the index. |
| `cover` | No | See "Cover images" below. |
| `readingTime` | No | Minutes. If omitted, computed from word count (~220 wpm). |
| `featured` | No | If `true`, this post appears as the large featured card at the top of the index. Only the first matching post is used. |
| `draft` | No | If `true`, the post is hidden from the index (but `post.html?slug=...` still works for previewing). |

---

## Cover images

You have two options.

### Option A: stylized text placeholder (default)

No image — just a coloured block with a label. Clean, fast, no asset to manage.

```json
"cover": {
  "label": "Welcome.",
  "color": "deep"
}
```

Available colors:

| Value | Background | Text |
|---|---|---|
| `mint` | Soft green | Teal |
| `deep` | Dark green | Bright green |
| `cream` | Warm off-white | Ink |
| `forest` | Forest green | Mint |
| `ink` | Near-black | Green |

### Option B: real image

Drop an image into `assets/blog/` and reference it:

```json
"cover": {
  "image": "assets/blog/apex-ground-hero.jpg"
}
```

Recommended size: **1600 × 900px** (16:9). JPG or WebP. Optimize before committing — large images slow the blog index.

---

## Tags

Tags become filter chips at the top of the blog index. They're case-sensitive — `"Case studies"` and `"case studies"` are treated as different tags. Pick a small vocabulary and stick to it.

Suggested set:

- `Announcements` — product launches, hiring, fundraising
- `Case studies` — real customer stories
- `Guides` — how-to / explainer content
- `Founder notes` — personal essays
- `Product updates` — changelogs, what shipped this month

Linking to a specific tag works: `blog.html?tag=Case%20studies`.

---

## SEO

Each post page automatically:

- Sets `<title>` to `<Post title> — BoostOwl Blog`
- Sets `<meta name="description">` to the excerpt
- Sets Open Graph tags (`og:title`, `og:description`, `og:type=article`, `og:url`, `og:image` if you have a cover image)
- Sets Twitter card metadata
- Injects JSON-LD `BlogPosting` schema for richer search results

This is all done client-side in `assets/blog.js`. Google crawls JS, but if you want the best possible SEO consider running a static-site generator step that pre-renders each post into its own HTML file. For now, the dynamic approach is plenty for a small blog.

---

## Writing tips

- **Be specific.** "76 contacts in the first month" beats "lots of customers."
- **Use the customer's voice.** Quote them. Use their words.
- **Short paragraphs.** Mobile readers bounce on walls of text.
- **One idea per post.** Don't try to cover everything.
- **Link to the product naturally.** A WhatsApp CTA at the bottom is fine — interrupting the flow with "and BOOK A DEMO NOW!!!" is not.

---

## Troubleshooting

**"Post not found"** — the `slug` in `posts.json` doesn't match the `.md` filename. Check spelling.

**The post shows up empty** — Markdown file is empty, or there's a fetch error. Open browser devtools → Console.

**Card looks wrong on the index** — make sure `posts.json` is valid JSON (no trailing commas, double-quoted keys). Paste it into [jsonlint.com](https://jsonlint.com) if unsure.

**Want to preview a post without publishing it?** Set `"draft": true` in the JSON entry. The post hides from the index but `post.html?slug=...` still renders it for you to share with reviewers.

---

That's the whole system. Two files per post. The complexity stops here.
