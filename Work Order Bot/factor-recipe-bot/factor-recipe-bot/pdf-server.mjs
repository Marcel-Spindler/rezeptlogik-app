// Local PDF generation server — receives HTML from browser, saves PDF to shared drive
// Usage: node pdf-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.FACTOR_OUT || 'G:\\Shared drives\\Recipe  Bible';
const STATE_FILE = path.join(__dir, 'generated-wos.json');
const TEMP_DIR = path.join(__dir, 'temp-html');

fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
function findChrome() {
  for (const p of CHROME_PATHS) { if (fs.existsSync(p)) return p; }
  throw new Error('Chrome executable not found');
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end('Method not allowed'); return; }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);

      if (req.url === '/update-state') {
        // Update generated-wos.json with new WOs and runCounts
        const state = fs.existsSync(STATE_FILE)
          ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
          : { doneWO: {}, runCount: {} };
        const today = new Date().toISOString().slice(0, 10);
        for (const wo of (payload.doneWOs || [])) state.doneWO[wo] = today;
        for (const [code, n] of Object.entries(payload.runCount || {})) state.runCount[code] = n;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // /pdf — convert HTML to PDF
      const { filename, html } = payload;
      const safeName = (filename || 'recipe').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
      const htmlPath = path.join(TEMP_DIR, safeName + '.html');
      const pdfPath = path.join(OUT_DIR, safeName + '.pdf');

      fs.writeFileSync(htmlPath, html, 'utf8');
      console.log('Generating PDF:', safeName);

      const chrome = findChrome();
      const htmlUri = 'file:///' + htmlPath.replace(/\\/g, '/');
      execSync(
        `"${chrome}" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="${pdfPath}" "${htmlUri}"`,
        { timeout: 60000 }
      );
      fs.unlinkSync(htmlPath);
      console.log('Saved:', pdfPath);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pdf: pdfPath }));
    } catch (e) {
      console.error('Error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
});

const PORT = 3001;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`PDF server ready on http://localhost:${PORT}`);
  console.log('Output dir:', OUT_DIR);
});
