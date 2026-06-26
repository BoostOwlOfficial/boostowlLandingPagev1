const fs = require('fs');
const path = require('path');

// Read once at cold start. The HTML is bundled via vercel.json `includeFiles`.
const html = fs.readFileSync(path.join(process.cwd(), 'legal', 'data-deletion.html'), 'utf8');

module.exports = (req, res) => {
  // Serve the full document as a plain 200. Unlike static assets, this ignores
  // any Range header, so crawlers (e.g. Meta) always receive the complete body
  // instead of a 206 Partial Content with only the <head>.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.status(200).send(html);
};
