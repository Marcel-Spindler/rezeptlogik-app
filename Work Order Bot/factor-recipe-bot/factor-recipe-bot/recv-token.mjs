// recv-token.mjs — tiny one-shot HTTP server that receives the Bearer token via POST
// and writes it to tmp-token.txt, then exits.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9876;
const OUT = path.join(__dir, 'tmp-token.txt');

const srv = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method !== 'POST' || req.url !== '/token') {
    res.writeHead(404); res.end('not found'); return;
  }
  let body = '';
  req.on('data', d => body += d.toString());
  req.on('end', () => {
    body = body.trim();
    if (!body || body.length < 50) {
      console.error('recv-token: empty or short body, rejecting');
      res.writeHead(400); res.end('empty'); return;
    }
    fs.writeFileSync(OUT, body, 'utf8');
    console.log('recv-token: wrote', body.length, 'chars to', OUT);
    res.writeHead(200); res.end('ok');
    setTimeout(() => { srv.close(); process.exit(0); }, 200);
  });
});

srv.listen(PORT, '127.0.0.1', () => {
  console.log('recv-token: listening on http://127.0.0.1:' + PORT + '/token');
});

// Safety timeout: if no token after 120s, exit
setTimeout(() => { console.error('recv-token: timeout, exiting'); process.exit(1); }, 120000);
