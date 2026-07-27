const fs = require('fs');
const path = require('path');

// Read once at cold start. Both are bundled via vercel.json `includeFiles`.
const shell = fs.readFileSync(path.join(process.cwd(), 'post.html'), 'utf8');
const posts = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'posts', 'posts.json'), 'utf8')
).posts;

const SITE = 'https://www.boostowl.io';
const OG_IMAGE = SITE + '/assets/og-image.png';

// Escape for use inside a double-quoted HTML attribute.
const attr = (s) =>
  String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function headFor(post, url) {
  const title = `${post.title} — BoostOwl Blog`;
  const desc = post.excerpt || 'A post from the BoostOwl blog.';

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: desc,
    datePublished: post.date,
    author: { '@type': 'Person', name: (post.author && post.author.name) || 'BoostOwl' },
    publisher: {
      '@type': 'Organization',
      name: 'BoostOwl',
      logo: { '@type': 'ImageObject', url: SITE + '/icon-512.png' }
    },
    image: OG_IMAGE,
    url: url
  };

  return `<title>${attr(title)}</title>
<meta name="description" content="${attr(desc)}" />
<link rel="canonical" href="${attr(url)}" />
<meta property="og:site_name" content="BoostOwl" />
<meta property="og:type" content="article" />
<meta property="og:url" content="${attr(url)}" />
<meta property="og:title" content="${attr(post.title)}" />
<meta property="og:description" content="${attr(desc)}" />
<meta property="og:image" content="${OG_IMAGE}" />
<meta property="og:image:secure_url" content="${OG_IMAGE}" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="BoostOwl — the operating system for SMBs on WhatsApp" />
<meta property="og:locale" content="en_IN" />
<meta property="article:published_time" content="${attr(post.date)}" />
${(post.tags || []).map((t) => `<meta property="article:tag" content="${attr(t)}" />`).join('\n')}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@boostowlio" />
<meta name="twitter:title" content="${attr(post.title)}" />
<meta name="twitter:description" content="${attr(desc)}" />
<meta name="twitter:image" content="${OG_IMAGE}" />
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
}

// Patterns for the shell's placeholder <head> tags. Deliberately regex rather than
// literal strings: post.html is CRLF, and a literal would silently no-op if the
// line endings or spacing ever changed — leaving crawlers on "Loading…".
const TITLE_RE = /<title>[\s\S]*?<\/title>/;
const DESC_RE = /[ \t]*<meta\s+name="description"[^>]*>\s*/i;

function injectHead(html, headBlock) {
  const stripped = html.replace(DESC_RE, '\n');
  return TITLE_RE.test(stripped)
    ? stripped.replace(TITLE_RE, headBlock)
    : stripped.replace('</head>', headBlock + '\n</head>'); // fallback, never silent
}

module.exports = (req, res) => {
  const slug = (req.query && req.query.slug) || '';
  const post = posts.find((p) => p.slug === slug);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');

  // Unknown slug: serve the shell unchanged so the client renders its own
  // "Post not found" state, but return 404 so search engines don't index it.
  if (!post) {
    res.status(404).send(shell);
    return;
  }

  const url = `${SITE}/blog/${encodeURIComponent(post.slug)}`;

  // Serve as a plain 200. Like the legal-page functions, this ignores any Range
  // header, so crawlers (e.g. Meta) always get the complete <head> rather than a
  // 206 Partial Content.
  res.status(200).send(injectHead(shell, headFor(post, url)));
};
