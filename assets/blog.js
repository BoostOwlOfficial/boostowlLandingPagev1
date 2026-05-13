/* =====================================================================
   BoostOwl — Blog engine
   Reads posts/posts.json and renders the index (blog.html) or
   a single post (post.html?slug=...).
   ===================================================================== */
(function(){
  'use strict';

  const POSTS_JSON = 'posts/posts.json';
  const MD_DIR     = 'posts/';

  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

  // ---- helpers ----
  function fmtDate(iso){
    try{
      const d = new Date(iso);
      return d.toLocaleDateString('en-IN', { year:'numeric', month:'short', day:'numeric' });
    } catch(e){ return iso; }
  }
  function escapeHtml(s){
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function initials(name){
    if(!name) return '?';
    return name.split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase();
  }
  function readingTime(text){
    const words = String(text||'').trim().split(/\s+/).length;
    return Math.max(1, Math.round(words / 220));
  }
  function coverHtml(post){
    const c = post.cover || {};
    if (c.image) {
      return `<img src="${escapeHtml(c.image)}" alt="${escapeHtml(post.title)}" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover;display:block;"/>`;
    }
    const tone = 'cover-' + (c.color || 'mint');
    const label = c.label || post.title;
    return `<div class="cover-ph ${tone}"><span class="label">${escapeHtml(label)}</span></div>`;
  }

  // ---- data loading ----
  async function loadPosts(){
    const res = await fetch(POSTS_JSON, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load posts.json (' + res.status + ')');
    const data = await res.json();
    const posts = Array.isArray(data) ? data : (data.posts || []);
    return posts
      .filter(p => !p.draft)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  async function loadMarkdown(slug){
    const res = await fetch(MD_DIR + slug + '.md', { cache: 'no-store' });
    if (!res.ok) throw new Error('Post not found: ' + slug);
    return res.text();
  }

  // ---- BLOG INDEX (blog.html) ----
  async function renderIndex(){
    const list = $('#post-list');
    const featuredMount = $('#featured-mount');
    const tagBar = $('#tag-bar');
    if (!list) return;

    let posts;
    try { posts = await loadPosts(); }
    catch(e){
      list.innerHTML = `<div class="state-block">
        <h3>Couldn't load posts</h3>
        <p>${escapeHtml(e.message)}</p>
      </div>`;
      return;
    }

    if (!posts.length){
      list.innerHTML = `<div class="blog-empty">No posts yet. Check back soon.</div>`;
      return;
    }

    // Build tag list
    const tagCounts = {};
    posts.forEach(p => (p.tags||[]).forEach(t => { tagCounts[t] = (tagCounts[t]||0) + 1; }));
    const tags = Object.keys(tagCounts).sort();
    if (tagBar){
      tagBar.innerHTML =
        `<button class="tag-pill active" data-tag="__all">All <span class="count">${posts.length}</span></button>` +
        tags.map(t => `<button class="tag-pill" data-tag="${escapeHtml(t)}">${escapeHtml(t)} <span class="count">${tagCounts[t]}</span></button>`).join('');
      tagBar.addEventListener('click', e => {
        const btn = e.target.closest('.tag-pill');
        if (!btn) return;
        $$('.tag-pill', tagBar).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tag = btn.dataset.tag;
        renderCards(posts, tag === '__all' ? null : tag);
      });
    }

    // Pick featured: explicit `featured: true`, else latest
    let featured = posts.find(p => p.featured) || posts[0];
    const rest = posts.filter(p => p.slug !== featured.slug);

    if (featuredMount && featured){
      featuredMount.innerHTML = featuredCardHtml(featured);
    }
    renderCards(rest, null);

    function renderCards(all, tag){
      const filtered = tag ? all.filter(p => (p.tags||[]).includes(tag)) : all;
      if (!filtered.length){
        list.innerHTML = `<div class="blog-empty">No posts in this tag yet.</div>`;
        return;
      }
      list.innerHTML = filtered.map(cardHtml).join('');
    }
  }

  function featuredCardHtml(p){
    const link = 'post.html?slug=' + encodeURIComponent(p.slug);
    return `
      <a href="${link}" class="cover" aria-label="${escapeHtml(p.title)}">${coverHtml(p)}</a>
      <div class="body">
        <div class="meta-row">
          <span>Featured</span>
          ${(p.tags||[]).slice(0,1).map(t => `<span>· ${escapeHtml(t)}</span>`).join('')}
        </div>
        <h2><a href="${link}">${escapeHtml(p.title)}</a></h2>
        <p class="excerpt">${escapeHtml(p.excerpt||'')}</p>
        <div class="byline">
          <span class="avatar">${escapeHtml(initials(p.author && p.author.name))}</span>
          <div>
            <b>${escapeHtml((p.author && p.author.name) || 'BoostOwl')}</b>
            <span> · ${fmtDate(p.date)} · ${p.readingTime || 4} min read</span>
          </div>
        </div>
      </div>
    `;
  }

  function cardHtml(p){
    const link = 'post.html?slug=' + encodeURIComponent(p.slug);
    return `
      <article class="post-card">
        <a href="${link}" class="cover" aria-label="${escapeHtml(p.title)}">${coverHtml(p)}</a>
        <a href="${link}" class="body">
          <div class="meta-row">
            ${(p.tags||[]).slice(0,1).map(t => `<span>${escapeHtml(t)}</span>`).join('')}
            <span class="dot"></span>
            <span class="date">${fmtDate(p.date)}</span>
          </div>
          <h3>${escapeHtml(p.title)}</h3>
          <p class="excerpt">${escapeHtml(p.excerpt||'')}</p>
          <span class="read">Read more
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </span>
        </a>
      </article>
    `;
  }

  // ---- SINGLE POST (post.html?slug=foo) ----
  async function renderPost(){
    const mount = $('#post-mount');
    if (!mount) return;

    const params = new URLSearchParams(location.search);
    const slug = params.get('slug');
    if (!slug){
      mount.innerHTML = stateBlock('No post selected',
        'Looks like you came here without a slug. <a href="blog.html">Back to all posts</a>.');
      return;
    }

    let posts, md;
    try {
      posts = await loadPosts();
      md    = await loadMarkdown(slug);
    } catch(e){
      mount.innerHTML = stateBlock('Post not found',
        `${escapeHtml(e.message)}. <a href="blog.html">See all posts</a>.`);
      return;
    }

    const post = posts.find(p => p.slug === slug);
    if (!post){
      mount.innerHTML = stateBlock('Post not found',
        `We don't have a post with slug <code>${escapeHtml(slug)}</code>. <a href="blog.html">See all posts</a>.`);
      return;
    }

    const html = window.marked ? window.marked.parse(md) : md;
    const rt   = post.readingTime || readingTime(md);

    // SEO: update title + meta tags
    document.title = post.title + ' — BoostOwl Blog';
    setMeta('description', post.excerpt || '');
    setMeta('og:title', post.title, true);
    setMeta('og:description', post.excerpt || '', true);
    setMeta('og:type', 'article', true);
    setMeta('og:url', location.href, true);
    if (post.cover && post.cover.image) setMeta('og:image', new URL(post.cover.image, location.href).href, true);
    setMeta('twitter:card', 'summary_large_image', true);

    // JSON-LD for richer search results
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      datePublished: post.date,
      description: post.excerpt || '',
      author: { '@type': 'Person', name: (post.author && post.author.name) || 'BoostOwl' },
      publisher: {
        '@type': 'Organization',
        name: 'BoostOwl',
        logo: { '@type': 'ImageObject', url: location.origin + '/assets/logo.png' }
      },
      url: location.href
    };
    let ldEl = document.getElementById('ld-jsonld');
    if (!ldEl){
      ldEl = document.createElement('script');
      ldEl.type = 'application/ld+json';
      ldEl.id = 'ld-jsonld';
      document.head.appendChild(ldEl);
    }
    ldEl.textContent = JSON.stringify(ld);

    // Render
    const author = post.author || { name: 'BoostOwl', role: '' };
    mount.innerHTML = `
      <a class="article-back" href="blog.html">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>
        Back to all posts
      </a>

      <header class="article-head">
        <div class="article-meta-top">
          ${(post.tags||[]).slice(0,1).map(t => `<span>${escapeHtml(t)}</span><span class="dot"></span>`).join('')}
          <span class="date">${fmtDate(post.date)}</span>
          <span class="dot"></span>
          <span class="reading">${rt} min read</span>
        </div>
        <h1>${escapeHtml(post.title)}</h1>
        ${post.excerpt ? `<p class="excerpt">${escapeHtml(post.excerpt)}</p>` : ''}

        <div class="article-byline">
          <span class="avatar">${escapeHtml(initials(author.name))}</span>
          <div class="who">
            <b>${escapeHtml(author.name)}</b>
            <span>${escapeHtml(author.role || 'BoostOwl team')}</span>
          </div>
          <div class="share" aria-label="Share">
            <button class="share-btn" data-share="twitter" title="Share on X / Twitter" aria-label="Share on X">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2H21.5l-7.5 8.57L23 22h-6.804l-5.328-6.97L4.8 22H1.54l8.034-9.18L1 2h6.96l4.82 6.37L18.244 2zm-1.193 18h1.832L7.04 4H5.105L17.05 20z"/></svg>
            </button>
            <button class="share-btn" data-share="linkedin" title="Share on LinkedIn" aria-label="Share on LinkedIn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5C4.98 4.88 3.88 6 2.5 6S0 4.88 0 3.5 1.1 1 2.5 1s2.48 1.12 2.48 2.5zM.22 8h4.56v14H.22V8zM7.5 8h4.38v1.93h.06c.61-1.16 2.1-2.38 4.32-2.38 4.62 0 5.48 3.04 5.48 7v7.45h-4.56v-6.6c0-1.57-.03-3.59-2.19-3.59-2.19 0-2.52 1.71-2.52 3.48V22H7.5V8z"/></svg>
            </button>
            <button class="share-btn" data-share="whatsapp" title="Share on WhatsApp" aria-label="Share on WhatsApp">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.92.51 3.78 1.49 5.43L2 22l4.79-1.57a9.86 9.86 0 0 0 5.25 1.5h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.02A9.84 9.84 0 0 0 12.04 2zm0 18.13h-.01a8.21 8.21 0 0 1-4.19-1.15l-.3-.18-3.13 1.03 1.04-3.05-.2-.31a8.21 8.21 0 0 1-1.26-4.36c0-4.54 3.7-8.23 8.24-8.23 2.2 0 4.27.86 5.82 2.41a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.69 8.22-8.22 8.22z"/></svg>
            </button>
            <button class="share-btn" data-share="copy" title="Copy link" aria-label="Copy link">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
            </button>
          </div>
        </div>
      </header>

      <div class="article-cover">${coverHtml(post)}</div>

      <div class="article-content">${html}</div>

      ${(post.tags||[]).length ? `
        <div class="article-tags">
          <span class="label">Tags</span>
          ${post.tags.map(t => `<a class="article-tag" href="blog.html?tag=${encodeURIComponent(t)}">${escapeHtml(t)}</a>`).join('')}
        </div>
      ` : ''}

      <div class="post-cta">
        <div>
          <h3>See BoostOwl in action</h3>
          <p>Message us on WhatsApp — we'll show you a working account on a real business in the same hour.</p>
        </div>
        <a class="btn" href="index.html#wa">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.92.51 3.78 1.49 5.43L2 22l4.79-1.57a9.86 9.86 0 0 0 5.25 1.5h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.02A9.84 9.84 0 0 0 12.04 2z"/></svg>
          Talk to us
        </a>
      </div>
    `;

    // Wire up share buttons
    $$('[data-share]', mount).forEach(btn => {
      btn.addEventListener('click', () => share(btn.dataset.share, post));
    });

    // Render related posts
    renderRelated(posts, post);
  }

  function renderRelated(allPosts, current){
    const mount = $('#related-mount');
    if (!mount) return;
    // Find posts sharing any tag, else just take latest others
    const tagSet = new Set(current.tags || []);
    const scored = allPosts
      .filter(p => p.slug !== current.slug)
      .map(p => ({
        p,
        score: (p.tags||[]).reduce((s,t) => s + (tagSet.has(t) ? 1 : 0), 0)
      }))
      .sort((a,b) => b.score - a.score || (b.p.date||'').localeCompare(a.p.date||''));
    const top = scored.slice(0, 3).map(s => s.p);
    if (!top.length) {
      mount.parentElement && (mount.parentElement.style.display = 'none');
      return;
    }
    mount.innerHTML = top.map(cardHtml).join('');
  }

  // ---- share / SEO helpers ----
  function share(kind, post){
    const url = location.href;
    const text = post.title + ' — BoostOwl';
    const enc = encodeURIComponent;
    let target;
    if (kind === 'twitter')  target = `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}`;
    if (kind === 'linkedin') target = `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`;
    if (kind === 'whatsapp') target = `https://wa.me/?text=${enc(text + ' ' + url)}`;
    if (kind === 'copy'){
      navigator.clipboard && navigator.clipboard.writeText(url);
      const btn = event.currentTarget;
      const old = btn.innerHTML;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4 4 10-10"/></svg>';
      setTimeout(() => btn.innerHTML = old, 1400);
      return;
    }
    if (target) window.open(target, '_blank', 'noopener');
  }

  function setMeta(name, value, og){
    const attr = og ? 'property' : 'name';
    let el = document.querySelector(`meta[${attr}="${name}"]`);
    if (!el){
      el = document.createElement('meta');
      el.setAttribute(attr, name);
      document.head.appendChild(el);
    }
    el.setAttribute('content', value);
  }

  function stateBlock(title, html){
    return `<div class="state-block">
      <h3>${escapeHtml(title)}</h3>
      <p>${html}</p>
    </div>`;
  }

  // ---- boot ----
  document.addEventListener('DOMContentLoaded', () => {
    renderIndex();
    renderPost();

    // Honor ?tag=X on blog.html
    const tag = new URLSearchParams(location.search).get('tag');
    if (tag && $('#tag-bar')){
      // Wait a tick for tags to render
      setTimeout(() => {
        const btn = $(`.tag-pill[data-tag="${CSS.escape(tag)}"]`);
        if (btn) btn.click();
      }, 80);
    }
  });
})();
