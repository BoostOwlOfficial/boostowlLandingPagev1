/* =====================================================================
   BoostOwl — safe markdown subset renderer

   Used for job description / requirements / nice-to-have markdown, which
   comes from the `jobs` table in Supabase.

   WHY NOT `marked`, WHICH THE BLOG USES
   The blog loads marked from a CDN and pipes it into innerHTML unsanitised.
   That is fine for git-committed posts. This page collects names, emails,
   phone numbers and resumes, so a compromised third-party script would read
   all of it. The markdown we need is a tiny subset, so we render it here
   with no network dependency and no HTML passthrough.

   THE SECURITY MODEL IS ONE LINE: escape everything FIRST, then add markup.
   Nothing below can emit a "<" that came from the source text, because by
   the time any rule runs, every "<" is already "&lt;".

   SUPPORTED   ## h2, ### h3, "-"/"*" bullets, "1." ordered lists,
               **bold**, *italic*, `code`, [text](https://url), paragraphs
   NOT         nested lists, tables, images, blockquotes (">" renders
               literally), fenced code blocks, raw HTML, reference links,
               autolinks. Job markdown in db/job-template.sql uses only the
               supported set.
   ===================================================================== */
(function (root) {
  'use strict';

  var MAX_INPUT = 20000;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* -------------------------------------------------------------------
     safeHref — the entire trust boundary for links.

     Input is the ALREADY-ESCAPED url text. That matters: escapeHtml does
     not touch ":" or "/", so a genuine "https://" survives verbatim, while
     an obfuscated "&#x6a;avascript:" has already become
     "&amp;#x6a;avascript:" and fails the https test below.

     Returns the escaped string (safe to drop straight into an attribute)
     or null to drop the link.
     ------------------------------------------------------------------- */
  function safeHref(u) {
    if (typeof u !== 'string' || !u || u.length > 500) return null;

    // Literal attribute-breaking or control characters.
    if (/[\s"'<>`\\]/.test(u)) return null;

    // An escaped quote or a numeric entity is an attempt to either break out
    // of href="..." or to obfuscate the scheme. "&amp;" is deliberately
    // allowed so query strings survive.
    if (/&(quot|apos|lt|gt|#\d|#x)/i.test(u)) return null;

    // The real gate. Kills javascript:, data:, http:, mailto:, //host and
    // every relative form.
    if (!/^https:\/\/[a-z0-9]/i.test(u)) return null;

    try {
      if (new URL(u.replace(/&amp;/g, '&')).protocol !== 'https:') return null;
    } catch (e) {
      return null;
    }
    return u;
  }

  /* -------------------------------------------------------------------
     Inline rules.

     Code spans and links are STASHED behind a sentinel rather than emitted
     directly, because otherwise `**x**` inside a code span would render as
     bold, and a url containing "**" would be mangled inside its own href.
     ------------------------------------------------------------------- */
  function inline(text) {
    var stash = [];
    function keep(html) { return '\u0000' + (stash.push(html) - 1) + '\u0000'; }

    var out = text;

    out = out.replace(/`([^`\n]{1,300})`/g, function (m, code) {
      return keep('<code>' + code + '</code>');
    });

    // The url allows ONE level of balanced parens, so a real link such as
    // https://en.wikipedia.org/wiki/Foo_(bar) survives intact. Without it the
    // match stops at the first ")" and leaves a stray bracket in the text.
    out = out.replace(/\[([^\]\n]{1,200})\]\(((?:[^()\s]|\([^()\s]*\)){1,500})\)/g, function (m, label, url) {
      var href = safeHref(url);
      if (!href) return label;   // unsafe url: keep the words, drop the link
      return keep('<a href="' + href + '" target="_blank" rel="noopener noreferrer nofollow">' + label + '</a>');
    });

    // No lookbehind: it throws a SyntaxError at parse time on older Safari,
    // which would kill this whole file. [^\s*] on both ends does the same job.
    out = out.replace(/\*\*([^\s*](?:[^*\n]{0,298}[^\s*])?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^\s*](?:[^*\n]{0,298}[^\s*])?)\*/g, '$1<em>$2</em>');

    return out.replace(/\u0000(\d+)\u0000/g, function (m, i) {
      return stash[Number(i)] || '';
    });
  }

  function groupBlocks(lines) {
    var blocks = [];
    var cur = null;

    function close() { if (cur) { blocks.push(cur); cur = null; } }
    function open(type) {
      if (!cur || cur.type !== type) { close(); cur = { type: type, lines: [] }; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, '');
      if (!line.trim()) { close(); continue; }

      var h = /^(#{2,3})\s+(.*)$/.exec(line);
      if (h) {
        close();
        blocks.push({ type: h[1].length === 2 ? 'h2' : 'h3', lines: [h[2]] });
        continue;
      }

      var ul = /^[-*]\s+(.*)$/.exec(line);
      if (ul) { open('ul'); cur.lines.push(ul[1]); continue; }

      var ol = /^\d{1,3}[.)]\s+(.*)$/.exec(line);
      if (ol) { open('ol'); cur.lines.push(ol[1]); continue; }

      open('p');
      cur.lines.push(line);
    }
    close();
    return blocks;
  }

  function renderBlock(b) {
    var items;
    switch (b.type) {
      case 'h2':
        return '<h2>' + inline(b.lines[0]) + '</h2>';
      case 'h3':
        return '<h3>' + inline(b.lines[0]) + '</h3>';
      case 'ul':
      case 'ol':
        items = b.lines.map(function (l) { return '<li>' + inline(l) + '</li>'; }).join('');
        return '<' + b.type + '>' + items + '</' + b.type + '>';
      default:
        // Soft line breaks inside a paragraph join with a space (CommonMark).
        return '<p>' + inline(b.lines.join(' ')) + '</p>';
    }
  }

  function render(md) {
    if (typeof md !== 'string' || !md.trim()) return '';

    var src = md.length > MAX_INPUT ? md.slice(0, MAX_INPUT) : md;
    src = src.replace(/\r\n?/g, '\n');
    src = src.replace(/\u0000/g, '');   // reserved as the stash sentinel
    src = escapeHtml(src);              // FIRST, always

    return groupBlocks(src.split('\n')).map(renderBlock).join('\n');
  }

  var api = { render: render, escapeHtml: escapeHtml, safeHref: safeHref };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.BoostOwlMD = api;
})(typeof window !== 'undefined' ? window : null);
