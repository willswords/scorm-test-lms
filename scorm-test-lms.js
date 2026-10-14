#!/usr/bin/env node
// SCORM 1.2 Test LMS — run any SCORM 1.2 package locally and watch every call it makes to the LMS.
// Usage: node scorm-test-lms.js [package.zip | package-folder] [--port 7830] [--no-open]
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { exec } = require('child_process');
const { pipeline } = require('stream/promises');

function usage() {
  console.log(`SCORM 1.2 Test LMS

  node scorm-test-lms.js [package.zip | package-folder] [--port 7830] [--no-open]

  Opens a local test LMS in your browser. You can also drop a .zip onto the page.
  Only this computer can reach it (it listens on 127.0.0.1). Press Ctrl+C to stop.`);
}

let PORT = 7830, OPEN = true, initialPath = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') PORT = parseInt(argv[++i], 10);
  else if (a === '--no-open') OPEN = false;
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else initialPath = a;
}

const UI_FILE = path.join(__dirname, 'scorm-test-lms.html');
const WORK = path.join(os.tmpdir(), 'scorm-test-lms');
let current = null;      // { id, name, root, extracted }
let lastError = null;
let loadCounter = 0;

// ── ZIP extraction (stored + deflate; streams each entry, so large videos are fine) ──
function zip64Error() {
  return new Error('This ZIP uses the ZIP64 format (over 4 GB or 65,535 files), which this tool does not read. Unzip it and run the tool on the folder instead.');
}
async function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fd.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}
async function extractZip(zipPath, destDir) {
  const fd = await fsp.open(zipPath, 'r');
  try {
    const { size } = await fd.stat();
    const tailLen = Math.min(size, 65557);
    const tail = await readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This file is not a ZIP archive.');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) throw zip64Error();

    const cd = await readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('The ZIP file is damaged (bad central directory).');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      const lho = cd.readUInt32LE(p + 42);
      if (csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || lho === 0xFFFFFFFF) throw zip64Error();
      const name = cd.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
      entries.push({ name, flags, method, csize, lho });
      p += 46 + nlen + elen + clen;
    }

    const root = path.resolve(destDir);
    for (const e of entries) {
      const rel = e.name.replace(/\\/g, '/');
      const out = path.resolve(root, rel);
      if (out !== root && !out.startsWith(root + path.sep)) throw new Error('The ZIP contains an unsafe path: ' + e.name);
      if (rel.endsWith('/')) { await fsp.mkdir(out, { recursive: true }); continue; }
      if (e.flags & 1) throw new Error('Encrypted ZIP entries are not supported: ' + e.name);
      await fsp.mkdir(path.dirname(out), { recursive: true });
      if (e.csize === 0) { await fsp.writeFile(out, ''); continue; }
      const lh = await readAt(fd, e.lho, 30);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('The ZIP file is damaged (bad entry header): ' + e.name);
      const start = e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const src = fs.createReadStream(zipPath, { start, end: start + e.csize - 1 });
      if (e.method === 0) await pipeline(src, fs.createWriteStream(out));
      else if (e.method === 8) await pipeline(src, zlib.createInflateRaw(), fs.createWriteStream(out));
      else throw new Error(`Unsupported compression method (${e.method}) for ${e.name}`);
    }
    return entries.length;
  } finally {
    await fd.close();
  }
}

// The manifest should be at the package root, but some zips wrap everything in one folder
async function findPackageRoot(dir) {
  if (fs.existsSync(path.join(dir, 'imsmanifest.xml'))) return dir;
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== '__MACOSX' && fs.existsSync(path.join(dir, d.name, 'imsmanifest.xml'))) return path.join(dir, d.name);
  }
  return null;
}

async function loadPackage(srcPath, displayName) {
  const st = await fsp.stat(srcPath);
  let root = srcPath, extracted = null;
  if (!st.isDirectory()) {
    extracted = path.join(WORK, 'pkg-' + Date.now());
    await fsp.mkdir(extracted, { recursive: true });
    try { await extractZip(srcPath, extracted); }
    catch (e) { await fsp.rm(extracted, { recursive: true, force: true }); throw e; }
    root = extracted;
  }
  const pkgRoot = await findPackageRoot(root);
  if (!pkgRoot) {
    if (extracted) await fsp.rm(extracted, { recursive: true, force: true });
    throw new Error('No imsmanifest.xml found, so this does not look like a SCORM package.');
  }
  const previous = current;
  current = { id: ++loadCounter, name: displayName || path.basename(srcPath), root: pkgRoot, extracted };
  lastError = null;
  if (previous && previous.extracted) fsp.rm(previous.extracted, { recursive: true, force: true }).catch(() => {});
  console.log(`Loaded package: ${current.name}`);
}

// ── HTTP ──
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.xml': 'application/xml', '.xsd': 'application/xml', '.dtd': 'application/xml-dtd',
  '.txt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt', '.srt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.wasm': 'application/wasm'
};

function sendText(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const sendJson = (res, code, obj) => sendText(res, code, 'application/json', JSON.stringify(obj));

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'text/plain', 'Not found: ' + path.basename(file));
    const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] !== '' || m[2] !== '')) {
      const start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
      const end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

async function handleUpload(req, res) {
  const name = decodeURIComponent(String(req.headers['x-filename'] || 'package.zip'));
  await fsp.mkdir(WORK, { recursive: true });
  const tmp = path.join(WORK, 'upload-' + Date.now() + '.zip');
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    await loadPackage(tmp, name);
    sendJson(res, 200, { id: current.id, name: current.name });
  } catch (e) {
    lastError = e.message;
    sendJson(res, 400, { error: e.message });
  } finally {
    fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '/index.html') return sendText(res, 200, 'text/html; charset=utf-8', fs.readFileSync(UI_FILE));
    if (p === '/api/package') return sendJson(res, 200, current ? { id: current.id, name: current.name } : { id: null, error: lastError });
    if (p === '/upload' && req.method === 'POST') return await handleUpload(req, res);
    const m = /^\/pkg\/(\d+)\/(.*)$/.exec(p);
    if (m) {
      if (!current || Number(m[1]) !== current.id) return sendText(res, 404, 'text/plain', 'This package is no longer loaded.');
      const file = path.resolve(current.root, m[2]);
      if (file !== current.root && !file.startsWith(current.root + path.sep)) return sendText(res, 403, 'text/plain', 'Forbidden');
      return serveFile(req, res, file);
    }
    sendText(res, 404, 'text/plain', 'Not found');
  } catch (e) {
    sendText(res, 500, 'text/plain', 'Server error: ' + e.message);
  }
});

function cleanup() {
  if (current && current.extracted) { try { fs.rmSync(current.extracted, { recursive: true, force: true }); } catch {} }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

(async () => {
  if (initialPath) {
    try { await loadPackage(path.resolve(initialPath), path.basename(initialPath)); }
    catch (e) { lastError = e.message; console.error('Could not load package: ' + e.message); }
  }
  server.on('error', e => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Try: --port ${PORT + 1}` : e.message);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}/`;
    console.log(`SCORM 1.2 Test LMS running at ${url}  (Ctrl+C to stop)`);
    if (OPEN) {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  });
})();
