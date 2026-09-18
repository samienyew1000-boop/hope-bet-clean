const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const FRONTEND_PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');
const API_DIR = path.join(ROOT_DIR, 'hope-bet-api');

// 1. Start Backend API process
let apiProcess = null;
const apiScript = path.join(API_DIR, 'src', 'index.js');
if (fs.existsSync(apiScript)) {
  console.log('[DevServer] Starting Hope Bet API backend...');
  apiProcess = fork(apiScript, [], {
    cwd: API_DIR,
    env: { ...process.env }
  });

  apiProcess.on('error', (err) => {
    console.error('[DevServer] Backend failed to start:', err);
  });
}

// 2. MIME types for static frontend files
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

// 3. Static server
const server = http.createServer((req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = req.url.split('?')[0];
  let safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[\/\\])+/, '');

  // Redirect root / to /frontend/ for consistent app behavior
  if (safePath === '/' || safePath === '\\') {
    res.writeHead(302, { Location: '/frontend/' });
    res.end();
    return;
  }

  // Short verification URLs for QR codes and barcodes (e.g. /v/H0017 or /check/H0017)
  if (urlPath === '/check' || urlPath.startsWith('/check/') || urlPath.startsWith('/v/')) {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const parts = urlPath.split('/').filter(Boolean);
    let target = '/frontend/' + qs;
    if (parts.length >= 2) {
      const code = parts[1];
      target = `/frontend/?check=${encodeURIComponent(code)}${qs ? '&' + qs.slice(1) : ''}`;
    }
    res.writeHead(302, { Location: target });
    res.end();
    return;
  }

  // Candidate file locations to check
  const candidates = [];
  if (safePath.startsWith('/frontend') || safePath.startsWith('\\frontend')) {
    const rel = safePath.replace(/^[\\\/]frontend[\\\/]?/, '');
    candidates.push(path.join(FRONTEND_DIR, rel));
    candidates.push(path.join(ROOT_DIR, safePath));
  } else {
    candidates.push(path.join(FRONTEND_DIR, safePath));
    candidates.push(path.join(ROOT_DIR, safePath));
  }

  function tryNext(index) {
    if (index >= candidates.length) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    let target = candidates[index];
    fs.stat(target, (err, stats) => {
      if (!err && stats.isDirectory()) {
        target = path.join(target, 'index.html');
      }

      fs.readFile(target, (err2, data) => {
        if (!err2) {
          const ext = path.extname(target).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
          });
          res.end(data);
        } else {
          tryNext(index + 1);
        }
      });
    });
  }

  tryNext(0);
});

function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(300);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(true);
    });
    socket.connect(port, host);
  });
}

async function startServer() {
  let port = Number(FRONTEND_PORT);
  while (!(await isPortAvailable(port))) {
    console.log(`[DevServer] Port ${port} is in use by another process, trying port ${port + 1}...`);
    port++;
  }

  server.listen(port, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(` Hope Bet is running!`);
    console.log(` Frontend URL:  http://localhost:${port}/frontend/`);
    console.log(` Also at:       http://localhost:${port}/`);
    console.log(` Backend API:   http://127.0.0.1:8787/api/health`);
    console.log(`======================================================\n`);
  });
}

startServer();

// Clean up child process on exit
function shutdown() {
  if (apiProcess) {
    apiProcess.kill();
  }
  process.exit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);
