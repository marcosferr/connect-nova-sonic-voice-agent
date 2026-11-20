#!/usr/bin/env node
// Node side of the synthetic caller. Serves the Chime page + audio fixtures,
// drives a headless Chrome via Puppeteer, and bridges a JSON-lines protocol:
//   stdin  : {"cmd":"play","file":"yes.mp3"} | {"cmd":"hangup"}
//   stdout : {"event":"joined"} {"event":"vad","state":"speech"|"silence"}
//            {"event":"playstart"|"playdone","name":...} {"event":"error",...}
// Usage: node caller.js --connection-file conn.json --audio-dir <dir> [--max-seconds 420] [--headful]

const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
const puppeteer = require('puppeteer');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const connectionFile = arg('connection-file');
const audioDir = arg('audio-dir');
const maxSeconds = parseInt(arg('max-seconds', '420'), 10);
const headful = process.argv.includes('--headful');
if (!connectionFile || !audioDir) {
  console.error('usage: node caller.js --connection-file conn.json --audio-dir <dir>');
  process.exit(2);
}
const connectionData = JSON.parse(fs.readFileSync(connectionFile, 'utf-8'));
const pageDir = path.join(__dirname, 'page');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url.startsWith('/audio/')) file = path.join(audioDir, path.basename(url));
  else file = path.join(pageDir, url === '/' ? 'index.html' : path.basename(url));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const browser = await puppeteer.launch({
    headless: headful ? false : 'new',
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const page = await browser.newPage();
  page.on('console', (msg) => process.stderr.write(`[page:${msg.type()}] ${msg.text()}\n`));
  page.on('pageerror', (e) => emit({ event: 'error', message: 'pageerror: ' + String(e) }));
  await page.exposeFunction('emitEvent', (s) => process.stdout.write(s + '\n'));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.evaluate((cd) => window.callerJoin(cd), connectionData);

  let closing = false;
  const shutdown = async (code) => {
    if (closing) return;
    closing = true;
    try { await page.evaluate(() => window.callerStop()); } catch (e) { /* ignore */ }
    try { await browser.close(); } catch (e) { /* ignore */ }
    server.close();
    process.exit(code);
  };

  setTimeout(() => { emit({ event: 'error', message: 'max-seconds reached' }); shutdown(3); },
    maxSeconds * 1000);

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let cmd;
    try { cmd = JSON.parse(line); } catch (e) { return; }
    if (cmd.cmd === 'play') {
      const url = `http://127.0.0.1:${port}/audio/${cmd.file}`;
      try {
        await page.evaluate((u, n) => window.callerPlay(u, n), url, cmd.file);
      } catch (e) {
        emit({ event: 'error', message: 'play failed: ' + String(e) });
      }
    } else if (cmd.cmd === 'hangup') {
      await shutdown(0);
    }
  });
  rl.on('close', () => shutdown(0));
})().catch((e) => {
  emit({ event: 'error', message: String((e && e.stack) || e) });
  process.exit(1);
});
