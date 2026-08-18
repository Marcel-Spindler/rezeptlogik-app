// Local HTTP server to receive gathered recipe JSON from browser (sync XHR POST)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dir, 'gathered');
fs.mkdirSync(DIR, { recursive: true });

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/save/')) {
    const filename = decodeURIComponent(path.basename(req.url.slice(6)));
    const filePath = path.join(DIR, filename);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      fs.writeFileSync(filePath, body, 'utf8');
      console.log('Saved:', filename, '(' + body.length + ' bytes)');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK:' + filename + ':' + body.length);
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/list') {
    const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(files));
    return;
  }

  res.writeHead(404); res.end('not found');
});

const PORT = 7355;
server.listen(PORT, '127.0.0.1', () => {
  console.log('gather-server ready on http://127.0.0.1:' + PORT);
});
