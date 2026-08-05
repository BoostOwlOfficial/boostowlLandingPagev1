#!/usr/bin/env node
// ============================================================================
// Tests for the safe markdown renderer. Not deployed (scripts/ is .vercelignored).
//   node scripts/test-careers-md.js
//
// The security tests are the point of this file. Job markdown comes from the
// Supabase `jobs` table; if that table were ever tampered with, this renderer
// is the only thing standing between it and the application form's DOM.
// ============================================================================

'use strict';

const MD = require('../assets/careers-md.js');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
    fail++;
  }
}

// The only tags the renderer is ever allowed to emit.
const ALLOWED_TAGS = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'code', 'a']);

/**
 * Assert the output contains no executable markup.
 *
 * This inspects REAL TAGS only. Scanning the raw output string produces false
 * positives: `<p>&lt;img src=x onerror=alert(1)&gt;</p>` contains the text
 * "onerror=" but is correctly escaped and renders as literal characters. What
 * matters is what ends up in the DOM as markup.
 */
function checkSafe(name, md) {
  const out = MD.render(md);
  const problems = [];

  for (const tag of out.match(/<[^>]*>/g) || []) {
    const m = /^<\/?\s*([a-z0-9]+)/i.exec(tag);
    const tagName = m ? m[1].toLowerCase() : '?';

    if (!ALLOWED_TAGS.has(tagName))                  problems.push(`disallowed tag ${tag}`);
    if (/\son\w+\s*=/i.test(tag))                    problems.push(`event handler in ${tag}`);
    if (/(javascript|data|vbscript)\s*:/i.test(tag)) problems.push(`dangerous scheme in ${tag}`);

    const href = /href="([^"]*)"/i.exec(tag);
    if (href && !/^https:\/\//i.test(href[1]))       problems.push(`non-https href ${href[1]}`);
  }

  // Any "<" that is not the start of an allowed tag means escaping was missed.
  if (/<(?!\/?(p|h2|h3|ul|ol|li|strong|em|code|a)[\s/>])/i.test(out)) {
    problems.push('unescaped "<" outside an allowed tag');
  }

  if (problems.length === 0) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        leaked: ${problems.join(', ')}\n        out:    ${out}`);
    fail++;
  }
}

function section(t) { console.log(`\n${t}\n`); }

// ---------------------------------------------------------------------------
section('XSS corpus — none of these may produce markup');

checkSafe('raw script tag',            '<script>alert(1)</script>');
checkSafe('img onerror',               '<img src=x onerror=alert(1)>');
checkSafe('svg onload',                '<svg onload=alert(1)>');
checkSafe('iframe',                    '<iframe src="https://evil.io"></iframe>');
checkSafe('javascript: link',          '[click](javascript:alert(1))');
checkSafe('JaVaScRiPt: mixed case',    '[click](JaVaScRiPt:alert(1))');
checkSafe('data: link',                '[click](data:text/html,<script>alert(1)</script>)');
checkSafe('vbscript: link',            '[click](vbscript:msgbox(1))');
checkSafe('protocol-relative link',    '[click](//evil.io/x)');
checkSafe('relative link',             '[click](/admin)');
checkSafe('http (not https) link',     '[click](http://evil.io)');
checkSafe('mailto link',               '[click](mailto:x@y.com)');
checkSafe('entity-encoded javascript', '[click](&#x6a;avascript:alert(1))');
checkSafe('decimal-entity javascript', '[click](&#106;avascript:alert(1))');
checkSafe('attribute breakout via quote', '[click](https://a.com/"onload=alert(1))');
checkSafe('attribute breakout via entity', '[click](https://a.com/&quot;onload=alert(1))');
checkSafe('backtick in url',           '[click](https://a.com/`x`)');
checkSafe('html in link label',        '[<img src=x onerror=alert(1)>](https://ok.com)');
checkSafe('html in heading',           '## <script>alert(1)</script>');
checkSafe('html in list item',         '- <img src=x onerror=alert(1)>');
checkSafe('html in code span',         '`<script>alert(1)</script>`');
checkSafe('html in bold',              '**<script>alert(1)</script>**');
checkSafe('nul sentinel injection',    'literal \u00000\u0000 sentinel [x](https://ok.com)');
checkSafe('nested brackets',           '[[x]](javascript:alert(1))');
checkSafe('uppercase tag',             '<SCRIPT>alert(1)</SCRIPT>');
checkSafe('null byte in scheme',       '[x](java\u0000script:alert(1))');

// ---------------------------------------------------------------------------
section('Safe links are preserved');

check('https link renders',
  MD.render('[BoostOwl](https://boostowl.io)'),
  '<p><a href="https://boostowl.io" target="_blank" rel="noopener noreferrer nofollow">BoostOwl</a></p>');

check('query string survives escaping',
  MD.render('[x](https://a.com/p?a=1&b=2)'),
  '<p><a href="https://a.com/p?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">x</a></p>');

check('unsafe link keeps its text, no stray bracket',
  MD.render('[click here](javascript:alert(1))'),
  '<p>click here</p>');

check('url with balanced parens survives',
  MD.render('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))'),
  '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer nofollow">wiki</a></p>');

check('safeHref accepts https', MD.safeHref('https://a.com/x'), 'https://a.com/x');
check('safeHref rejects http', MD.safeHref('http://a.com/x'), null);
check('safeHref rejects javascript', MD.safeHref('javascript:alert(1)'), null);
check('safeHref rejects empty', MD.safeHref(''), null);
check('safeHref rejects over-long', MD.safeHref('https://a.com/' + 'x'.repeat(600)), null);

// ---------------------------------------------------------------------------
section('Block rendering');

check('h2', MD.render('## What you will do'), '<h2>What you will do</h2>');
check('h3', MD.render('### Bonus'), '<h3>Bonus</h3>');
check('paragraph', MD.render('Hello world.'), '<p>Hello world.</p>');

check('hyphen bullets',
  MD.render('- one\n- two'),
  '<ul><li>one</li><li>two</li></ul>');

check('asterisk bullets',
  MD.render('* one\n* two'),
  '<ul><li>one</li><li>two</li></ul>');

check('ordered list',
  MD.render('1. first\n2. second'),
  '<ol><li>first</li><li>second</li></ol>');

check('soft line breaks join with a space',
  MD.render('line one\nline two'),
  '<p>line one line two</p>');

check('blank line separates paragraphs',
  MD.render('one\n\ntwo'),
  '<p>one</p>\n<p>two</p>');

check('heading then list',
  MD.render('## Title\n- a'),
  '<h2>Title</h2>\n<ul><li>a</li></ul>');

check('list then paragraph',
  MD.render('- a\n\nafter'),
  '<ul><li>a</li></ul>\n<p>after</p>');

// ---------------------------------------------------------------------------
section('Inline rendering');

check('bold', MD.render('**strong**'), '<p><strong>strong</strong></p>');
check('italic', MD.render('*em*'), '<p><em>em</em></p>');
check('code', MD.render('`code`'), '<p><code>code</code></p>');
check('bold inside a sentence', MD.render('a **b** c'), '<p>a <strong>b</strong> c</p>');
check('code span protects bold', MD.render('`**x**`'), '<p><code>**x**</code></p>');
check('unmatched asterisks left alone', MD.render('2 * 3 * 4'), '<p>2 * 3 * 4</p>');
check('bold with no inner space required', MD.render('** x **'), '<p>** x **</p>');

check('bold inside a list item',
  MD.render('- **Node.js** and Postgres'),
  '<ul><li><strong>Node.js</strong> and Postgres</li></ul>');

// ---------------------------------------------------------------------------
section('Escaping and edge cases');

check('ampersand escaped', MD.render('R&D'), '<p>R&amp;D</p>');
check('less-than escaped', MD.render('a < b'), '<p>a &lt; b</p>');
check('quotes escaped', MD.render('say "hi"'), '<p>say &quot;hi&quot;</p>');
check('blockquote renders literally (unsupported)', MD.render('> quoted'), '<p>&gt; quoted</p>');

check('empty string', MD.render(''), '');
check('whitespace only', MD.render('   \n\n  '), '');
check('null input', MD.render(null), '');
check('undefined input', MD.render(undefined), '');
check('number input', MD.render(42), '');
check('object input', MD.render({}), '');

check('very long input is truncated, not hung',
  MD.render('a'.repeat(50000)).length < 30000, true);

// ---------------------------------------------------------------------------
section('Realistic job markdown (db/job-template.sql)');
{
  const out = MD.render([
    'You will own backend surfaces end to end.',
    '',
    '- Design and build the APIs behind our contacts and orders modules',
    '- Own our **WhatsApp Business API** integration: webhooks, retries',
    '- Model data for multi-tenant SMB workloads',
    '',
    '### Bonus',
    '',
    'Read the [docs](https://platform.example.com/docs) first.',
  ].join('\n'));

  check('renders a paragraph', /<p>You will own/.test(out), true);
  check('renders the bullet list', (out.match(/<li>/g) || []).length, 3);
  check('renders bold inside a bullet', /<strong>WhatsApp Business API<\/strong>/.test(out), true);
  check('renders the h3', /<h3>Bonus<\/h3>/.test(out), true);
  check('renders the safe link', /href="https:\/\/platform\.example\.com\/docs"/.test(out), true);
  check('no stash sentinel leaked', out.includes('\u0000'), false);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
