#!/usr/bin/env node
// SCORM Test LMS — run a SCORM 1.2, SCORM 2004 or xAPI (Tin Can) package locally and watch everything it sends to the LMS/LRS.
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

  Opens a local test LMS (SCORM 1.2, SCORM 2004 and xAPI/Tin Can) in your browser.
  You can also drop a .zip onto the page.
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

// Temp files are named with the server's process ID so a later run can tell which ones are orphaned
// (left behind when a server was closed without Ctrl+C) and delete them without touching another running server's files.
function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function removeOrphanedTempFiles() {
  let names = [];
  try { names = fs.readdirSync(WORK); } catch { return; }
  for (const n of names) {
    const m = /^(?:pkg|upload)-(\d+)-\d+(?:\.zip)?$/.exec(n);
    const orphaned = m ? Number(m[1]) !== process.pid && !isRunning(Number(m[1]))
                       : /^(?:pkg|upload)-\d+(?:\.zip)?$/.test(n); // older naming without a process ID
    if (orphaned) { try { fs.rmSync(path.join(WORK, n), { recursive: true, force: true }); } catch {} }
  }
}

// The package's descriptor (SCORM imsmanifest.xml, xAPI tincan.xml, or cmi5.xml) should be at the root,
// but some zips wrap everything in one folder
const DESCRIPTORS = ['imsmanifest.xml', 'tincan.xml', 'cmi5.xml'];
const hasDescriptor = d => DESCRIPTORS.some(f => fs.existsSync(path.join(d, f)));
async function findPackageRoot(dir) {
  if (hasDescriptor(dir)) return dir;
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== '__MACOSX' && hasDescriptor(path.join(dir, d.name))) return path.join(dir, d.name);
  }
  return null;
}
function packageKind(root) {
  if (fs.existsSync(path.join(root, 'imsmanifest.xml'))) return 'scorm';
  if (fs.existsSync(path.join(root, 'tincan.xml'))) return 'xapi';
  return 'cmi5';
}

async function loadPackage(srcPath, displayName) {
  const st = await fsp.stat(srcPath);
  let root = srcPath, extracted = null;
  if (!st.isDirectory()) {
    extracted = path.join(WORK, 'pkg-' + process.pid + '-' + Date.now());
    await fsp.mkdir(extracted, { recursive: true });
    try { await extractZip(srcPath, extracted); }
    catch (e) { await fsp.rm(extracted, { recursive: true, force: true }); throw e; }
    root = extracted;
  }
  const pkgRoot = await findPackageRoot(root);
  const kind = pkgRoot && packageKind(pkgRoot);
  if (!pkgRoot || kind === 'cmi5') {
    if (extracted) await fsp.rm(extracted, { recursive: true, force: true });
    throw new Error(kind === 'cmi5'
      ? 'This is a cmi5 package. The test LMS supports SCORM 1.2, SCORM 2004 and xAPI (Tin Can) packages, but not cmi5 yet.'
      : 'No imsmanifest.xml or tincan.xml found, so this does not look like a SCORM or xAPI package.');
  }
  const previous = current;
  current = { id: ++loadCounter, name: displayName || path.basename(srcPath), root: pkgRoot, extracted, kind };
  lastError = null;
  resetStorylineOverrides(); // every package starts with its own settings
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

// ── Storyline testing overrides: menu navigation, seekbar lock, Next/Prev lock ──
// The files on disk are never changed; values are swapped as the files are sent to the course.
let flowOverride = null;      // null = as packaged, otherwise 'free' or 'restricted'
let seekbarUnlocked = false;  // serve the seekbar as draggable
let navUnlocked = false;      // keep Next/Prev enabled even when slide triggers disable them
const FLOW_FILES = { xml: 'story_content/frame.xml', js: 'html5/data/js/frame.js' };
const SLIDE_JS_DIR = 'html5/data/js';
// frame.js and the slide files hold JSON inside a JS string, so quotes may or may not be backslash-escaped
const Q = '\\\\?"';
const FLOW_RE = {
  xml: /(<option\s+name="flow"\s+value=")([^"]*)(")/,
  js: new RegExp(`(${Q}menuOptions${Q}\\s*:\\s*\\{[^{}]*?${Q}flow${Q}\\s*:\\s*${Q})([^"\\\\]*)(${Q})`)
};
const SEEK_RE = {
  readonly: new RegExp(`(${Q}controls${Q}\\s*:\\s*\\{[^{}]*?${Q}readonly${Q}\\s*:\\s*)(true|false)`),
  readonlyOnce: new RegExp(`(${Q}controls${Q}\\s*:\\s*\\{[^{}]*?${Q}readonlyOnce${Q}\\s*:\\s*)(true|false)`)
};
// Slide triggers such as {"kind":"enable_window_control","name":"next","enable":false}
const lockTrigger = names => new RegExp(`(${Q}kind${Q}\\s*:\\s*${Q}enable_window_control${Q}\\s*,\\s*${Q}name${Q}\\s*:\\s*${Q}(?:${names})${Q}\\s*,\\s*${Q}enable${Q}\\s*:\\s*)false`, 'g');
const NAV_LOCK_RE = lockTrigger('next|prev|previous|swiperight|swipeleft');
const SEEK_LOCK_RE = lockTrigger('seekbar');
const isSlideJs = rel => rel.startsWith(SLIDE_JS_DIR + '/') && /^[^/]+\.js$/.test(rel.slice(SLIDE_JS_DIR.length + 1)) && rel !== FLOW_FILES.js;
const countMatches = (re, text) => (text.match(re) || []).length;

function storylineInfo() {
  if (!current) return { storyline: false };
  const read = rel => { try { return fs.readFileSync(path.join(current.root, rel), 'utf8'); } catch { return null; } };
  const files = {};
  let any = false, frameJs = null;
  for (const k of ['xml', 'js']) {
    const text = read(FLOW_FILES[k]);
    if (k === 'js') frameJs = text;
    if (text == null) { files[k] = null; continue; }
    any = true;
    const m = FLOW_RE[k].exec(text);
    files[k] = m ? m[2] : '';
  }
  if (!any) return { storyline: false };
  const seekbar = { readonly: null, readonlyOnce: null };
  if (frameJs) for (const k of ['readonly', 'readonlyOnce']) { const m = SEEK_RE[k].exec(frameJs); if (m) seekbar[k] = m[2] === 'true'; }
  const nav = { slideFiles: 0, lockedFiles: 0, navLocks: 0, seekLocks: 0 };
  try {
    for (const n of fs.readdirSync(path.join(current.root, SLIDE_JS_DIR))) {
      const rel = SLIDE_JS_DIR + '/' + n;
      if (!isSlideJs(rel)) continue;
      const t = read(rel);
      if (t == null) continue;
      nav.slideFiles++;
      const locks = countMatches(NAV_LOCK_RE, t);
      if (locks) nav.lockedFiles++;
      nav.navLocks += locks;
      nav.seekLocks += countMatches(SEEK_LOCK_RE, t);
    }
  } catch {}
  return { storyline: true, files, paths: FLOW_FILES, override: flowOverride, seekbar, nav, seekbarUnlocked, navUnlocked,
    quiz: quizKey(), answersPreselected };
}
function storylineOverrideActive() { return !!(flowOverride || seekbarUnlocked || navUnlocked || answersPreselected); }

// ── Storyline quiz answers: the answer key Storyline writes into html5/data/js/data.js ──
// Each question ("interaction") lists its choices, which answer is "correct", and which slide object
// (a radio button or checkbox) records each choice. With answersPreselected on, question slides are
// served with the correct choices already checked, so the learner only has to press Submit.
let answersPreselected = false;
const DATA_JS = SLIDE_JS_DIR + '/data.js';
const PRESELECTABLE = ['multiplechoice', 'multipleresponse', 'truefalse'];
// The data files are window.globalProvideData('<kind>', '<JSON in a single-quoted JS string>').
// They come from the package, so they're parsed as data and never run.
const PROVIDE_RE = /globalProvideData\(\s*'(\w+)'\s*,\s*'([\s\S]*)'\s*\)\s*;?\s*$/;
function unescapeJsString(s) {
  return s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (m, e) => {
    if (e.length > 1 && e[0] === 'u') return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e.length === 3 && e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '', '\r': '', '\r\n': '', ' ': '', ' ': '' };
    return e in map ? map[e] : e;
  });
}
function readProvided(text) {
  const m = PROVIDE_RE.exec(text.replace(/^﻿/, ''));
  if (!m) return null;
  try { return { kind: m[1], data: JSON.parse(unescapeJsString(m[2])) }; } catch { return null; }
}
const writeProvided = (kind, data) => `window.globalProvideData('${kind}', ${JSON.stringify(JSON.stringify(data))});`;

function quizKey() {
  if (!current) return null;
  if (current.quizKey === undefined) {
    current.quizKey = null;
    try {
      const d = readProvided(fs.readFileSync(path.join(current.root, DATA_JS), 'utf8'));
      if (d && d.kind === 'data') current.quizKey = buildQuizKey(d.data);
    } catch {}
  }
  return current.quizKey;
}
// Numeric questions: a condition such as {"kind":"or","statements":[{"kind":"compare","operator":"eq",…,"valueb":4}]}
const OPERATOR_WORDS = { eq: '=', noteq: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' };
function describeCondition(st) {
  if (!st) return '';
  if (st.kind === 'or' || st.kind === 'and') {
    const parts = st.statements || [];
    const ops = Object.fromEntries(parts.filter(p => p.kind === 'compare').map(p => [p.operator, p.valueb]));
    if (st.kind === 'and' && parts.length === 2 && 'gte' in ops && 'lte' in ops) return 'between ' + ops.gte + ' and ' + ops.lte;
    return parts.map(describeCondition).filter(Boolean).join(st.kind === 'or' ? ' or ' : ' and ');
  }
  if (st.kind === 'compare') return st.operator === 'eq' ? String(st.valueb) : (OPERATOR_WORDS[st.operator] || st.operator) + ' ' + st.valueb;
  return '';
}
// A number that meets the condition, to type into the box
function numberFor(st) {
  if (!st) return null;
  if (st.kind === 'or') { for (const p of st.statements || []) { const n = numberFor(p); if (n != null) return n; } return null; }
  if (st.kind === 'and') {
    let lo = -Infinity, hi = Infinity, eq = null;
    for (const p of st.statements || []) {
      if (p.kind !== 'compare' || typeof p.valueb !== 'number') return null;
      if (p.operator === 'eq') eq = p.valueb;
      else if (p.operator === 'gte') lo = Math.max(lo, p.valueb); else if (p.operator === 'gt') lo = Math.max(lo, p.valueb + 1);
      else if (p.operator === 'lte') hi = Math.min(hi, p.valueb); else if (p.operator === 'lt') hi = Math.min(hi, p.valueb - 1);
    }
    return eq != null ? eq : lo !== -Infinity ? (lo <= hi ? lo : null) : hi !== Infinity ? hi : null;
  }
  if (st.kind === 'compare' && typeof st.valueb === 'number')
    return { eq: st.valueb, gte: st.valueb, lte: st.valueb, gt: st.valueb + 1, lt: st.valueb - 1, noteq: st.valueb + 1 }[st.operator] ?? null;
  return null;
}
function findObject(root, id) {
  let hit = null;
  (function walk(o) { if (hit || !o || typeof o !== 'object') return; if (o.id === id) { hit = o; return; } for (const k in o) walk(o[k]); })(root);
  return hit;
}

function buildQuizKey(data) {
  const quizOf = new Map();   // slide id → its quiz
  for (const q of data.quizzes || []) for (const r of q.sliderefs || []) quizOf.set(String(r.id).split('.').pop(), q);
  const slideCache = new Map();
  const loadSlide = file => {
    if (!slideCache.has(file)) { let d = null; try { const p = readProvided(fs.readFileSync(path.join(current.root, file), 'utf8')); d = p && p.data; } catch {} slideCache.set(file, d); }
    return slideCache.get(file);
  };
  const questions = [];
  // Question slides are in the scenes, or in question banks (slideBank) that a quiz draws from
  const slides = [];
  for (const scene of data.scenes || []) for (const slide of scene.slides || []) slides.push({ slide, bank: false });
  for (const slide of (data.slideBank && data.slideBank.slides) || []) slides.push({ slide, bank: true });
  const onlyQuiz = (data.quizzes || []).length === 1 ? data.quizzes[0] : null;
  for (const { slide, bank } of slides) for (const it of slide.interactions || []) {
    const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const choices = new Map((it.choices || []).map(c => ['choices.' + c.id, clean(c.lmstext)]));
    const targets = new Map((it.statements || []).map(s => ['statements.' + s.id, clean(s.lmstext)]));   // matching: where each item goes
    const label = v => choices.has(v) ? choices.get(v) : targets.has(v) ? targets.get(v) : JSON.stringify(v);
    // responseDefinition: "if <group>.<object>.#_checked is true, record choice X"
    const objectFor = new Map();
    for (const a of (it.responseDefinition && it.responseDefinition.actions) || []) {
      const v = a && a.condition && a.condition.statement && a.condition.statement.valuea;
      const add = (a && a.thenActions || []).find(t => t && t.kind === 'addchoiceresponse');
      if (typeof v === 'string' && add && /\.#_checked$/.test(v)) { const parts = v.split('.'); objectFor.set(add.value, parts[parts.length - 2]); }
    }
    const describe = st => st.kind === 'equals' && st.choiceid ? label(st.choiceid)
      : st.choiceid && st.statementid ? label(st.choiceid) + ' → ' + label(st.statementid)
      : st.kind + ' ' + Object.entries(st).filter(([k]) => k !== 'kind' && k !== 'ignorecase').map(([k, v]) => k + ' ' + label(v)).join(', ');
    const correct = (it.answers || []).filter(a => a && a.status === 'correct');
    const sts0 = (correct[0] && correct[0].evaluate && correct[0].evaluate.statements) || [];
    const actions = (it.responseDefinition && it.responseDefinition.actions) || [];
    // The text box a fill-in or numeric answer is typed into, and the course variable it's bound to
    const boundVariable = () => {
      const add = actions.find(a => a && a.kind === 'addchoiceresponse' && /^\w+\.\$Text$/.test(a.value));
      const input = add && findObject(loadSlide(slide.html5url), add.value.split('.')[0]);
      const m = input && input.kind === 'textinput' && /^_player\.(\w+)$/.exec(input.bindto || '');
      return m ? m[1] : null;
    };
    let answers = correct.map(a => ({ points: a.points, parts: ((a.evaluate && a.evaluate.statements) || []).map(describe) }));
    let prefill = null, apply = null, note = '';
    if (PRESELECTABLE.includes(it.type)) {
      // Check the correct choices: on-slide radio buttons or checkboxes
      if (sts0.length && sts0.every(st => st.kind === 'equals' && objectFor.has(st.choiceid))) {
        apply = { checked: sts0.map(st => objectFor.get(st.choiceid)) };
        prefill = { how: 'select' };
      }
    } else if (it.type === 'fillin') {
      // Any one of the accepted answers will do
      const accepted = sts0.filter(st => st.kind === 'equals' && st.choiceid).map(st => label(st.choiceid));
      answers = accepted.map(t => ({ points: correct[0].points, parts: [t] }));
      if (sts0.some(st => st.ignorecase)) note = 'not case-sensitive';
      const v = boundVariable();
      if (accepted.length && v) { apply = { projectVars: { [v]: accepted[0] } }; prefill = { how: 'type', value: accepted[0] }; }
    } else if (it.type === 'numeric') {
      const cond = sts0.length === 1 && sts0[0].kind === 'condition' ? sts0[0].statement : null;
      const n = numberFor(cond), v = boundVariable();
      if (cond) answers = [{ points: correct[0].points, parts: [describeCondition(cond)] }];
      if (n != null && v) { apply = { projectVars: { [v]: String(n) } }; prefill = { how: 'type', value: String(n) }; }
    } else if (it.type === 'sequence') {
      // Each item's position, in order
      answers = answers.map((a, i) => ({ points: a.points, parts: (correct[i].evaluate.statements || [])
        .map(st => ({ pos: label(st.statementid), item: label(st.choiceid) })).sort((x, y) => parseFloat(x.pos) - parseFloat(y.pos))
        .map(p => p.pos + '. ' + p.item) }));
    } else if (it.type === 'hotspot') {
      answers = answers.map(a => ({ points: a.points, parts: a.parts.map(p => 'Click inside “' + p + '”') }));
      // "if the click (#…_xpos, #…_ypos) is inside <shape>, record the correct choice": record a click at the shape's centre
      const hit = sts0.length === 1 && actions.find(a => a && a.condition && a.condition.statement && a.condition.statement.kind === 'hittestpoint' &&
        (a.thenActions || []).some(t => t && t.kind === 'addchoiceresponse' && t.value === sts0[0].choiceid));
      const ht = hit && hit.condition.statement;
      const layer = loadSlide(slide.html5url) && loadSlide(slide.html5url).slideLayers && loadSlide(slide.html5url).slideLayers[0];
      const shape = ht && layer && (layer.objects || []).find(o => o && o.id === ht.objRef.value);   // directly on the slide, so its position is in slide coordinates
      const xv = ht && /^#(\w+_xpos)$/.exec(ht.xPos && ht.xPos.value || ''), yv = ht && /^#(\w+_ypos)$/.exec(ht.yPos && ht.yPos.value || '');
      if (shape && xv && yv && !shape.rotation) {
        const cx = Math.round(shape.xPos + shape.width / 2), cy = Math.round(shape.yPos + shape.height / 2);
        const marker = (layer.objects || []).find(o => o && o.id === xv[1].replace(/_xpos$/, '_marker'));
        apply = { slideVars: { [xv[1]]: cx, [yv[1]]: cy } };
        if (marker) {
          apply.move = { [marker.id]: { xPos: cx - Math.round(marker.width / 2), yPos: cy - Math.round(marker.height / 2) } };
          apply.show = [marker.id];   // normally shown only once the learner clicks
        }
        prefill = { how: 'click' };
      }
    }
    const quiz = quizOf.get(slide.id) || (bank ? onlyQuiz : null);
    // Questions are often labelled just "Multiple Choice"; then use the question's wording from the slide
    let title = clean(it.lmstext);
    if (!title || GENERIC_TITLE.test(title)) title = questionText(slide.html5url) || title || clean(slide.title);
    questions.push({
      slideId: slide.id, file: slide.html5url || '', title, type: it.type || '', survey: !!it.issurvey, bank,
      quiz: quiz ? quiz.lmstext || quiz.id : '', choices: [...choices.values()], correct: answers, note, prefill, apply
    });
  }
  // A course variable shared by text boxes with different answers can't hold them all, so those aren't pre-filled
  const varValues = new Map();
  for (const q of questions) for (const [k, v] of Object.entries((q.apply && q.apply.projectVars) || {})) varValues.set(k, (varValues.get(k) || new Set()).add(v));
  for (const q of questions) if (q.apply && q.apply.projectVars && Object.keys(q.apply.projectVars).some(k => varValues.get(k).size > 1)) { q.apply = null; q.prefill = null; }
  if (!questions.length) return null;
  return { quizzes: (data.quizzes || []).map(q => ({ name: q.lmstext || q.id, passPercent: q.passPercent, survey: !!q.issurvey })), questions };
}
const GENERIC_TITLE = /^(multiple choice|multiple response|true ?\/? ?false|drag and drop|matching( drag and drop| drop-?down)?|fill[- ]in[- ]the[- ]blanks?|word bank|sequence( drag and drop| drop-?down)?|numeric|hotspot|likert( scale)?|pick (one|many)|ranking( drag and drop| drop-?down)?|how many|essay|short answer|free ?form.*|question( ?\d+)?)$/i;
// The longest text box on the slide's base layer, leaving out answer choices and buttons
function questionText(file) {
  try {
    const p = readProvided(fs.readFileSync(path.join(current.root, file), 'utf8'));
    const layer = p && p.data.slideLayers && p.data.slideLayers[0];
    let best = '';
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (o.accType && o.accType !== 'text') return;
      for (const t of Array.isArray(o.textLib) ? o.textLib : []) {
        const s = ((t && t.vartext && t.vartext.blocks) || []).map(b => (b.spans || []).map(sp => sp.text).join('')).join(' ').replace(/\s+/g, ' ').trim();
        if (s.length > best.length) best = s;
      }
      for (const k in o) if (k !== 'textLib') walk(o[k]);
    })(layer && layer.objects);
    return best;
  } catch { return ''; }
}
// Serve a file with the correct answers filled in:
//   checked     - choice objects whose "checked" variable starts true (multiple choice/response, true/false)
//   slideVars   - slide variables to start with a value (a hotspot's recorded click position)
//   move        - objects to start at another position (the hotspot's click marker)
//   show        - objects to show from the start of the slide (the marker)
//   projectVars - course variables in data.js to start with a value (what's typed into fill-in and numeric boxes)
function applyAnswers(text, applies) {
  const p = readProvided(text);
  if (!p) return text;
  const checked = new Set(applies.flatMap(a => a.checked || []));
  const show = new Set(p.kind === 'slide' ? applies.flatMap(a => a.show || []) : []);
  const slideVars = Object.assign({}, ...applies.map(a => a.slideVars || {}));
  const move = Object.assign({}, ...applies.map(a => a.move || {}));
  const projectVars = p.kind === 'data' ? Object.assign({}, ...applies.map(a => a.projectVars || {})) : {};
  let n = 0;
  const setVar = (v, value) => { v.value = v.type === 'number' ? Number(value) : v.type === 'boolean' ? !!value : String(value); n++; };
  for (const v of (p.kind === 'slide' && Array.isArray(p.data.variables)) ? p.data.variables : []) if (v && v.name in slideVars) setVar(v, slideVars[v.name]);
  for (const v of Array.isArray(p.data.variables) ? p.data.variables : []) if (v && v.name in projectVars) setVar(v, projectVars[v.name]);
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.id === 'string') {
      if (checked.has(o.id) && Array.isArray(o.variables)) for (const v of o.variables) if (v && v.name === '_checked') { v.value = true; n++; }
      if (move[o.id]) { Object.assign(o, move[o.id]); n++; }
    }
    for (const k in o) walk(o[k]);
  })(p.kind === 'slide' ? p.data : null);
  // Show: add a "show" action at the start of the timeline of the layer the object is on
  for (const layer of show.size && Array.isArray(p.data.slideLayers) ? p.data.slideLayers : []) {
    const ids = (layer.objects || []).map(o => o && o.id).filter(id => show.has(id));
    if (!ids.length) continue;
    layer.timeline = layer.timeline || { duration: 0, events: [] };
    layer.timeline.events = layer.timeline.events || [];
    let start = layer.timeline.events.find(e => e && e.kind === 'ontimelinetick' && e.time === 0);
    if (!start) layer.timeline.events.unshift(start = { kind: 'ontimelinetick', time: 0, actions: [] });
    start.actions = start.actions || [];
    for (const id of ids) { start.actions.push({ kind: 'show', transition: 'appear', objRef: { type: 'string', value: id } }); n++; }
  }
  return n ? writeProvided(p.kind, p.data) : text;
}
// ── Completion criteria set by the authoring tool (the page reads the manifest's own rules) ──
//   Articulate Storyline: "scorings" in html5/data/js/data.js, one per tracking option (quiz result, slides viewed)
//   SCORM Video Packager: config.xml <player-config>, or the settings built into its index.html
function completionCriteria() {
  if (!current) return null;
  if (current.criteria !== undefined) return current.criteria;
  const read = rel => { try { return fs.readFileSync(path.join(current.root, rel), 'utf8'); } catch { return null; } };
  let out = null;
  try {
    const dataJs = read(DATA_JS);
    const d = dataJs && readProvided(dataJs);
    if (d && d.kind === 'data') out = storylineCriteria(d.data);
    else {
      const cfg = read('config.xml');
      const tag = name => { const m = cfg && new RegExp('<' + name + '(?:\\s[^>]*)?>([^<]*)</' + name + '>').exec(cfg); return m ? m[1].trim() : null; };
      if (cfg && /<player-config[\s>]/.test(cfg)) {
        const ack = /<acknowledgment[^>]*\benabled="true"/.test(cfg);
        out = videoPackagerCriteria(parseFloat(tag('threshold')), tag('allow-self-complete') === 'true', ack, 'config.xml');
      } else {
        const idx = read('index.html') || '';
        const m = /const CFG=\{\s*threshold:([\d.]+),\s*allowSelfComplete:(true|false),\s*enableAck:(true|false)/.exec(idx);
        if (m) out = videoPackagerCriteria(parseFloat(m[1]) * 100, m[2] === 'true', m[3] === 'true', 'index.html');
      }
    }
  } catch {}
  return (current.criteria = out);
}
function storylineCriteria(data) {
  const quizName = id => { const q = (data.quizzes || []).find(x => x.id === id); return q ? q.lmstext || id : id; };
  // Slides that count as viewed: those tracking views, plus the questions each question-bank draw shows
  let counted = 0, drawn = 0;
  for (const scene of data.scenes || []) for (const slide of scene.slides || []) if (slide.trackViews === true) counted++;
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.kind === 'slidedraw') { const n = o.shuffle && o.shufflecount > 0 ? o.shufflecount : (o.sliderefs || []).length; drawn += n; return; }
    for (const k in o) walk(o[k]);
  })(data.scenes);
  counted += drawn;
  const criteria = (data.scorings || []).map(s => {
    if (s.type === 'quiz') {
      const names = (s.scoreRefs || []).map(r => '“' + quizName(r.ref) + '”').join(' and ');
      return { kind: 'quiz', passPercent: s.passPercent, text: s.passPercent > 0
        ? 'Pass the quiz ' + names + ' with ' + s.passPercent + '% or more'
        : 'Finish the quiz ' + names + ' (pass mark 0%, so any score passes)' };
    }
    if (s.type === 'trigger') return { kind: 'trigger', text: 'Reach a slide with a Complete Course trigger' };
    if (s.type === 'view') {
      const from = drawn ? ', including ' + drawn + ' drawn from a question bank' : '';
      return { kind: 'view', viewThreshold: s.viewThreshold, counted,
        text: counted && s.viewThreshold >= counted ? 'View all ' + counted + ' slides' + (from ? ' (' + from.slice(2) + ')' : '')
          : 'View at least ' + s.viewThreshold + ' slide' + (s.viewThreshold === 1 ? '' : 's') + (counted ? ' (of the ' + counted + ' that count' + from + ')' : '') };
    }
    return { kind: s.type, text: 'Storyline tracking type “' + s.type + '”' };
  });
  const status = v => ({ pass: 'Passed', complete: 'Completed', completed: 'Completed', fail: 'Failed', failed: 'Failed', incomplete: 'Incomplete' })[v] || v;
  const s0 = (data.scorings || [])[0];
  return {
    tool: 'Articulate Storyline', source: 'html5/data/js/data.js', criteria,
    any: criteria.length > 1,   // Storyline counts the course complete when any one is met
    reports: s0 ? { met: status(s0.passStatus), notMet: status(s0.failStatus) } : null,
    note: criteria.length ? '' : 'No tracking option is set in this Storyline file, so completion comes from the course’s own triggers.'
  };
}
function videoPackagerCriteria(thresholdPercent, selfComplete, ack, source) {
  const criteria = [{ kind: 'watch', text: 'Watch at least ' + (isNaN(thresholdPercent) ? '100' : Math.round(thresholdPercent)) + '% of the video (skipped parts don’t count)' }];
  if (selfComplete) criteria.push({ kind: 'button', text: 'Or press the “Mark as complete” button' });
  return { tool: 'SCORM Video Packager', source, criteria, any: selfComplete,
    then: ack ? 'Then confirm the acknowledgement; completion is only reported after that.' : '',
    reports: { met: 'Passed', notMet: 'Incomplete', score: 100 } };
}

function transformStoryline(rel, text) {
  if (rel === FLOW_FILES.xml) return flowOverride ? text.replace(FLOW_RE.xml, '$1' + flowOverride + '$3') : text;
  if (rel === FLOW_FILES.js) {
    if (flowOverride) text = text.replace(FLOW_RE.js, '$1' + flowOverride + '$3');
    if (seekbarUnlocked) text = text.replace(SEEK_RE.readonly, '$1false').replace(SEEK_RE.readonlyOnce, '$1false');
    return text;
  }
  if (isSlideJs(rel)) {
    if (navUnlocked) text = text.replace(NAV_LOCK_RE, '$1true');
    if (seekbarUnlocked) text = text.replace(SEEK_LOCK_RE, '$1true');
    if (answersPreselected) {
      const key = quizKey();
      const applies = key ? key.questions.filter(q => q.apply && (rel === DATA_JS ? q.apply.projectVars : q.file === rel)).map(q => q.apply) : [];
      if (applies.length) text = applyAnswers(text, applies);
    }
  }
  return text;
}
function isStorylineFile(rel) { return rel === FLOW_FILES.xml || rel === FLOW_FILES.js || isSlideJs(rel); }
function serveStoryline(res, file, rel) {
  fs.readFile(file, 'utf8', (err, text) => {
    if (err) return sendText(res, 404, 'text/plain', 'Not found');
    sendText(res, 200, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', transformStoryline(rel, text));
  });
}
function resetStorylineOverrides() { flowOverride = null; seekbarUnlocked = false; navUnlocked = false; answersPreselected = false; }

function closePackage() {
  const old = current;
  current = null;
  resetStorylineOverrides();
  lastError = null;
  if (old && old.extracted) fsp.rm(old.extracted, { recursive: true, force: true }).catch(() => {});
  if (old) console.log(`Closed package: ${old.name}`);
}

// ════════════════════════════════════════════════════════════════════════════
//  Built-in xAPI LRS (Learning Record Store), for xAPI / Tin Can packages
// ════════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const LRS_FILE = path.join(WORK, 'lrs-data.json');
const LRS_AUTH = 'Basic ' + Buffer.from('testlms:testlms').toString('base64');
const LAUNCH_ACTOR = { objectType: 'Agent', name: 'Learner, Test', mbox: 'mailto:learner@example.com' };
const AUTHORITY = { objectType: 'Agent', name: 'SCORM Test LMS', mbox: 'mailto:test-lms@example.com' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IRI = /^[a-z][a-z0-9+.-]*:\S+$/i;
const ISO8601_DUR = /^P(?=\d|T\d)(\d+(\.\d+)?Y)?(\d+(\.\d+)?M)?(\d+(\.\d+)?W)?(\d+(\.\d+)?D)?(T(?=\d)(\d+(\.\d+)?H)?(\d+(\.\d+)?M)?(\d+(\.\d+)?S)?)?$/;
const ISO8601_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const STATEMENT_KEYS = new Set(['id', 'actor', 'verb', 'object', 'result', 'context', 'timestamp', 'stored', 'authority', 'version', 'attachments', 'objectType']);

let lrs = { registrations: {}, statements: [], docs: {} };
try { lrs = Object.assign(lrs, JSON.parse(fs.readFileSync(LRS_FILE, 'utf8'))); } catch {}
let lrsSaveTimer = 0;
function saveLrs() {
  clearTimeout(lrsSaveTimer);
  lrsSaveTimer = setTimeout(() => {
    fs.mkdir(WORK, { recursive: true }, () => fs.writeFile(LRS_FILE, JSON.stringify(lrs), () => {}));
  }, 300);
}
let launchInfo = null; // { activityId, registration, actorKey } of the course currently launched

// Live feed of LRS requests for the test LMS page (Server-Sent Events)
const eventClients = new Set();
function xapiEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  eventClients.add(res);
  req.on('close', () => eventClients.delete(res));
}
function emit(ev) {
  const data = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const c of eventClients) c.write(data);
}

function agentKey(a) {
  if (!a || typeof a !== 'object') return '';
  if (a.mbox) return 'mbox:' + String(a.mbox).toLowerCase();
  if (a.mbox_sha1sum) return 'sha1:' + String(a.mbox_sha1sum).toLowerCase();
  if (a.openid) return 'openid:' + a.openid;
  if (a.account) return 'account:' + a.account.homePage + '::' + a.account.name; // no "|": it separates parts of document keys
  return '';
}
const langText = m => (m && typeof m === 'object' ? m['en-US'] || m['en'] || m[Object.keys(m)[0]] || '' : '');
const verbName = v => (v && (langText(v.display) || String(v.id || '').split('/').pop())) || '?';
function describeStatement(s) {
  const who = (s.actor && (s.actor.name || s.actor.mbox || agentKey(s.actor))) || '?';
  const o = s.object || {};
  const what = o.objectType === 'Agent' || o.objectType === 'Group' ? (o.name || agentKey(o)) :
    o.objectType === 'StatementRef' ? 'statement ' + o.id : langText(o.definition && o.definition.name) || o.id || '?';
  const r = s.result || {};
  const bits = [];
  if (r.score) bits.push('score ' + (r.score.scaled != null ? r.score.scaled : r.score.raw + (r.score.max != null ? '/' + r.score.max : '')));
  if (r.success != null) bits.push(r.success ? 'success' : 'not successful');
  if (r.completion != null) bits.push(r.completion ? 'complete' : 'not complete');
  if (r.duration) bits.push(r.duration);
  return who + ' ' + verbName(s.verb) + ' "' + what + '"' + (bits.length ? ' (' + bits.join(', ') + ')' : '');
}

// Returns an error message if the statement must be rejected; pushes warnings into issues
function validateStatement(s, issues, where) {
  const at = where ? ' (' + where + ')' : '';
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'A statement must be a JSON object' + at + '.';
  for (const k of Object.keys(s)) if (!STATEMENT_KEYS.has(k)) return 'Unknown statement property "' + k + '"' + at + '. LRSs reject statements with properties that aren’t in the xAPI spec.';
  if (s.id != null && !UUID.test(s.id)) return 'Statement id "' + s.id + '" is not a valid UUID' + at + '.';
  const agentErr = validateAgent(s.actor, 'actor');
  if (agentErr) return agentErr + at;
  if (!s.verb || typeof s.verb !== 'object' || !IRI.test(s.verb.id || '')) return 'The verb needs an "id" that is a full IRI, such as http://adlnet.gov/expapi/verbs/completed' + at + '.';
  if (s.verb.display != null && (typeof s.verb.display !== 'object' || Array.isArray(s.verb.display))) return 'verb.display must be a language map, such as {"en-US": "completed"}' + at + '.';
  if (!s.verb.display) issues.push(['warn', 'A "' + verbName(s.verb) + '" statement has no verb.display, so LMS reports may show the raw verb IRI.']);
  const o = s.object;
  if (!o || typeof o !== 'object') return 'The statement has no "object"' + at + '.';
  const ot = o.objectType || 'Activity';
  if (ot === 'Activity') { if (!IRI.test(o.id || '')) return 'The object activity needs an "id" that is a full IRI' + at + '.'; }
  else if (ot === 'Agent' || ot === 'Group') { const e = validateAgent(o, 'object'); if (e) return e + at; }
  else if (ot === 'StatementRef') { if (!UUID.test(o.id || '')) return 'A StatementRef object needs a UUID "id"' + at + '.'; }
  else if (ot !== 'SubStatement') return 'Unknown object.objectType "' + ot + '"' + at + '.';
  const r = s.result;
  if (r != null) {
    if (typeof r !== 'object') return '"result" must be an object' + at + '.';
    if (r.success != null && typeof r.success !== 'boolean') return 'result.success must be true or false (not a string)' + at + '.';
    if (r.completion != null && typeof r.completion !== 'boolean') return 'result.completion must be true or false (not a string)' + at + '.';
    if (r.duration != null && !ISO8601_DUR.test(r.duration)) return 'result.duration "' + r.duration + '" is not an ISO 8601 duration such as PT1M30S' + at + '.';
    const sc = r.score;
    if (sc != null) {
      if (typeof sc !== 'object') return 'result.score must be an object' + at + '.';
      for (const k of ['scaled', 'raw', 'min', 'max']) if (sc[k] != null && typeof sc[k] !== 'number') return 'result.score.' + k + ' must be a number' + at + '.';
      if (sc.scaled != null && (sc.scaled < -1 || sc.scaled > 1)) return 'result.score.scaled must be between -1 and 1' + at + '.';
      if (sc.min != null && sc.max != null && sc.min > sc.max) return 'result.score.min is greater than result.score.max' + at + '.';
      if (sc.raw != null && ((sc.min != null && sc.raw < sc.min) || (sc.max != null && sc.raw > sc.max))) return 'result.score.raw is outside min–max' + at + '.';
    }
  }
  const c = s.context;
  if (c != null) {
    if (typeof c !== 'object') return '"context" must be an object' + at + '.';
    if (c.registration != null && !UUID.test(c.registration)) return 'context.registration "' + c.registration + '" is not a valid UUID' + at + '.';
  }
  if (s.timestamp != null && !ISO8601_TS.test(s.timestamp)) return 'timestamp "' + s.timestamp + '" is not an ISO 8601 date-time' + at + '.';
  // Launch-aware checks: an LMS links statements to the enrolment through the launch registration and actor
  if (launchInfo) {
    const reg = c && c.registration;
    if (!reg) issues.push(['warn', 'A "' + verbName(s.verb) + '" statement has no context.registration. LMSs use the registration from the launch URL to link statements to the learner’s enrolment.']);
    else if (reg !== launchInfo.registration) issues.push(['warn', 'A statement used registration ' + reg + ', not the one from the launch URL (' + launchInfo.registration + ').']);
    if (agentKey(s.actor) && agentKey(s.actor) !== launchInfo.actorKey) issues.push(['warn', 'A statement’s actor (' + agentKey(s.actor) + ') isn’t the learner from the launch URL.']);
  }
  return null;
}
function validateAgent(a, label) {
  if (!a || typeof a !== 'object') return 'The statement has no "' + label + '"';
  if (a.objectType && a.objectType !== 'Agent' && a.objectType !== 'Group') return label + '.objectType must be "Agent" or "Group"';
  const ifis = ['mbox', 'mbox_sha1sum', 'openid', 'account'].filter(k => a[k] != null);
  if (a.objectType === 'Group' && ifis.length === 0 && Array.isArray(a.member)) return null; // anonymous group
  if (ifis.length !== 1) return label + ' must have exactly one identifier (mbox, mbox_sha1sum, openid or account); it has ' + (ifis.length || 'none');
  if (a.mbox && !/^mailto:/i.test(a.mbox)) return label + '.mbox must start with "mailto:"';
  if (a.account && (!a.account.homePage || !a.account.name)) return label + '.account needs both homePage and name';
  return null;
}

function stripStored(s) { const c = { ...s }; delete c.stored; delete c.authority; delete c.version; delete c.voided; return JSON.stringify(c); }
function storeStatement(s) {
  const now = new Date().toISOString();
  const stored = { ...s, id: s.id || crypto.randomUUID(), stored: now, authority: AUTHORITY, version: s.version || '1.0.0', timestamp: s.timestamp || now };
  const existing = lrs.statements.find(x => x.id === stored.id);
  if (existing) return stripStored(existing) === stripStored({ ...stored, timestamp: s.timestamp || existing.timestamp }) ? existing.id : null; // null = conflict
  if (stored.verb && stored.verb.id === 'http://adlnet.gov/expapi/verbs/voided' && stored.object && stored.object.objectType === 'StatementRef') {
    const target = lrs.statements.find(x => x.id === stored.object.id);
    if (target) target.voided = true;
  }
  lrs.statements.push(stored);
  return stored.id;
}
function publicStatement(s) { const c = { ...s }; delete c.voided; return c; }

// Document stores: activities/state, activities/profile, agents/profile
function docKey(kind, q, agentK) {
  if (kind === 'state') return ['state', q.get('activityId'), agentK, q.get('registration') || '', q.get('stateId')].join('|');
  if (kind === 'aprof') return ['aprof', q.get('activityId'), q.get('profileId')].join('|');
  return ['agprof', agentK, q.get('profileId')].join('|');
}
const isJsonType = t => /application\/json/i.test(t || '');
function etagOf(buf) { return '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"'; }

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 50 * 1024 * 1024) throw new Error('Request body over 50 MB'); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function handleXapi(req, res, url) {
  const q = new URLSearchParams(url.searchParams);
  let method = req.method, headers = { ...req.headers }, body = await readBody(req);
  // xAPI 1.0 "alternate request syntax": POST ?method=PUT with the headers and content in a form body
  if (method === 'POST' && q.has('method')) {
    method = q.get('method').toUpperCase();
    q.delete('method');
    for (const [k, v] of new URLSearchParams(body.toString('utf8'))) {
      const lk = k.toLowerCase();
      if (lk === 'content') body = Buffer.from(v, 'utf8');
      else if (['authorization', 'x-experience-api-version', 'content-type', 'if-match', 'if-none-match'].includes(lk)) headers[lk] = v;
      else q.set(k, v);
    }
  }
  const resource = url.pathname.replace(/^\/xapi\/?/, '').replace(/\/+$/, '');
  const ev = { t: Date.now(), method, resource, query: {}, status: 0, issues: [], summary: '' };
  for (const [k, v] of q) if (['stateId', 'profileId', 'statementId', 'registration', 'verb', 'since', 'limit'].includes(k)) ev.query[k] = v;
  const base = {
    'X-Experience-API-Version': '1.0.3', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Experience-API-Version, If-Match, If-None-Match',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'ETag, Last-Modified, X-Experience-API-Version, X-Experience-API-Consistent-Through'
  };
  const reply = (status, payload, extra = {}) => {
    const isBuf = Buffer.isBuffer(payload);
    const text = payload == null ? '' : isBuf ? payload : typeof payload === 'string' ? payload : JSON.stringify(payload);
    const type = extra['Content-Type'] || (payload == null ? undefined : typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json');
    res.writeHead(status, { ...base, ...(type ? { 'Content-Type': type } : {}), ...extra });
    res.end(text);
    ev.status = status;
    if (status >= 400 && typeof payload === 'string' && !ev.error) ev.error = payload;
    if (method !== 'OPTIONS') emit(ev);
  };
  const reject = (status, msg, level = 'error') => { ev.issues.push([level, msg]); return reply(status, msg); };

  if (method === 'OPTIONS') return reply(204, null);
  if (resource === 'about') return reply(200, { version: ['1.0.3', '1.0.2', '1.0.1', '1.0.0'] });
  const ver = headers['x-experience-api-version'];
  if (!ver) return reject(400, 'Request to /' + resource + ' had no X-Experience-API-Version header. LRSs must reject these.');
  if (!/^1\.0(\.\d+)?$/.test(ver)) return reject(400, 'Unsupported X-Experience-API-Version "' + ver + '". This LRS supports 1.0.x.');
  if (!headers.authorization) return reject(401, 'Request to /' + resource + ' had no Authorization header. Use the "auth" value from the launch URL.');
  if (headers.authorization !== LRS_AUTH) ev.issues.push(['warn', 'The Authorization header isn’t the one from the launch URL. A real LRS would refuse this request.']);

  let agentK = '';
  if (q.has('agent')) {
    let a; try { a = JSON.parse(q.get('agent')); } catch { return reject(400, 'The "agent" parameter is not valid JSON.'); }
    const e = validateAgent(a, 'agent'); if (e) return reject(400, e + '.');
    agentK = agentKey(a);
  }

  if (resource === 'statements') {
    if (method === 'POST' || method === 'PUT') {
      if (/multipart\/mixed/i.test(headers['content-type'] || '')) return reject(400, 'Statements with attachments (multipart/mixed) aren’t supported by this test LRS.', 'warn');
      let data; try { data = JSON.parse(body.toString('utf8')); } catch { return reject(400, 'The statement body is not valid JSON.'); }
      const list = method === 'PUT' ? [data] : Array.isArray(data) ? data : [data];
      if (method === 'PUT') {
        const sid = q.get('statementId');
        if (!sid) return reject(400, 'PUT /statements needs a statementId parameter.');
        if (!UUID.test(sid)) return reject(400, 'statementId "' + sid + '" is not a valid UUID.');
        if (data && data.id && data.id !== sid) return reject(400, 'The statement’s id doesn’t match the statementId parameter.');
        if (data && typeof data === 'object') data.id = sid;
      }
      for (let i = 0; i < list.length; i++) {
        const err = validateStatement(list[i], ev.issues, list.length > 1 ? 'statement ' + (i + 1) + ' of ' + list.length : '');
        if (err) return reject(400, err);
      }
      const ids = [];
      for (const s of list) {
        const sid = storeStatement(s);
        if (!sid) return reject(409, 'A different statement with id ' + s.id + ' already exists. Statement ids must be unique.');
        ids.push(sid);
      }
      ev.statements = list.map(describeStatement);
      saveLrs();
      return method === 'PUT' ? reply(204, null) : reply(200, ids);
    }
    if (method === 'GET') {
      const one = q.get('statementId') || q.get('voidedStatementId');
      if (one) {
        const s = lrs.statements.find(x => x.id === one && (q.has('voidedStatementId') ? x.voided : !x.voided));
        return s ? reply(200, publicStatement(s)) : reply(404, 'No statement with that id.');
      }
      let list = lrs.statements.filter(x => !x.voided);
      if (q.get('registration')) list = list.filter(x => x.context && x.context.registration === q.get('registration'));
      if (q.get('verb')) list = list.filter(x => x.verb && x.verb.id === q.get('verb'));
      if (q.get('activity')) list = list.filter(x => x.object && x.object.id === q.get('activity'));
      if (agentK) list = list.filter(x => agentKey(x.actor) === agentK);
      if (q.get('since')) list = list.filter(x => x.stored > q.get('since'));
      if (q.get('until')) list = list.filter(x => x.stored <= q.get('until'));
      list = list.slice().sort((a, b) => (a.stored < b.stored ? 1 : -1));
      if (q.get('ascending') === 'true') list.reverse();
      const limit = parseInt(q.get('limit') || '0', 10);
      if (limit > 0) list = list.slice(0, limit);
      ev.summary = list.length + ' statement(s)';
      return reply(200, { statements: list.map(publicStatement), more: '' }, { 'X-Experience-API-Consistent-Through': new Date().toISOString() });
    }
    return reject(405, method + ' isn’t allowed on /statements.');
  }

  const docKind = resource === 'activities/state' ? 'state' : resource === 'activities/profile' ? 'aprof' : resource === 'agents/profile' ? 'agprof' : null;
  if (docKind) {
    const idParam = docKind === 'state' ? 'stateId' : 'profileId';
    if (docKind !== 'agprof' && !q.get('activityId')) return reject(400, '/' + resource + ' needs an activityId parameter.');
    if (docKind !== 'aprof' && !agentK) return reject(400, '/' + resource + ' needs an agent parameter.');
    if (docKind === 'state' && q.get('registration') && !UUID.test(q.get('registration'))) return reject(400, 'registration "' + q.get('registration') + '" is not a valid UUID.');
    const id = q.get(idParam);
    const prefix = docKey(docKind, q, agentK).replace(/[^|]*$/, '');
    if (method === 'GET' && !id) {
      const since = q.get('since');
      const ids = Object.entries(lrs.docs).filter(([k, d]) => k.startsWith(prefix) && (!since || d.updated > since)).map(([k]) => k.slice(prefix.length));
      ev.summary = ids.length + ' document id(s)';
      return reply(200, ids);
    }
    if (method === 'DELETE' && !id) {
      if (docKind !== 'state') return reject(400, 'DELETE /' + resource + ' needs a ' + idParam + '.');
      let n = 0;
      for (const k of Object.keys(lrs.docs)) if (k.startsWith(prefix)) { delete lrs.docs[k]; n++; }
      ev.summary = 'deleted ' + n + ' document(s)';
      saveLrs();
      return reply(204, null);
    }
    if (!id) return reject(400, method + ' /' + resource + ' needs a ' + idParam + ' parameter.');
    const key = docKey(docKind, q, agentK);
    const doc = lrs.docs[key];
    if (method === 'GET') {
      if (!doc) { ev.summary = '"' + id + '" not saved yet'; return reply(404, 'No document "' + id + '".'); }
      const buf = Buffer.from(doc.data, 'base64');
      ev.summary = '"' + id + '" (' + buf.length + ' bytes)';
      return reply(200, buf, { 'Content-Type': doc.contentType || 'application/octet-stream', ETag: etagOf(buf), 'Last-Modified': new Date(doc.updated).toUTCString() });
    }
    if (method === 'DELETE') {
      delete lrs.docs[key]; saveLrs();
      ev.summary = 'deleted "' + id + '"';
      return reply(204, null);
    }
    if (method === 'PUT' || method === 'POST') {
      // Profiles use optimistic concurrency: overwriting an existing profile needs If-Match (or If-None-Match: *)
      if (docKind !== 'state') {
        const cur = doc ? etagOf(Buffer.from(doc.data, 'base64')) : null;
        if (headers['if-match'] && headers['if-match'] !== cur) return reject(412, 'If-Match "' + headers['if-match'] + '" doesn’t match the current version of "' + id + '".');
        if (headers['if-none-match'] === '*' && doc) return reject(412, 'If-None-Match: * was sent, but "' + id + '" already exists.');
        if (method === 'PUT' && doc && !headers['if-match'] && !headers['if-none-match']) return reject(409, 'PUT to an existing profile "' + id + '" without If-Match or If-None-Match. LRSs must reject this to prevent lost updates.');
      }
      const type = headers['content-type'] || 'application/octet-stream';
      let data = body;
      if (method === 'POST' && doc) {
        // POST merges JSON objects
        if (!isJsonType(type) || !isJsonType(doc.contentType)) return reject(400, 'POST to "' + id + '" can only merge JSON documents; use PUT to replace it.');
        let a, b;
        try { a = JSON.parse(Buffer.from(doc.data, 'base64').toString('utf8')); b = JSON.parse(body.toString('utf8')); } catch { return reject(400, 'POST to "' + id + '": the document isn’t valid JSON.'); }
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return reject(400, 'POST to "' + id + '" can only merge JSON objects.');
        data = Buffer.from(JSON.stringify({ ...a, ...b }), 'utf8');
      } else if (method === 'POST' && isJsonType(type)) {
        try { const o = JSON.parse(body.toString('utf8')); if (!o || typeof o !== 'object' || Array.isArray(o)) throw 0; }
        catch { return reject(400, 'POST to "' + id + '": the body must be a JSON object.'); }
      }
      lrs.docs[key] = { contentType: type, data: data.toString('base64'), updated: new Date().toISOString() };
      saveLrs();
      ev.summary = (method === 'POST' && doc ? 'merged into "' : 'saved "') + id + '" (' + data.length + ' bytes)';
      return reply(204, null);
    }
    return reject(405, method + ' isn’t allowed on /' + resource + '.');
  }

  if (resource === 'activities' && method === 'GET') {
    const aid = q.get('activityId');
    if (!aid) return reject(400, '/activities needs an activityId parameter.');
    const withDef = lrs.statements.slice().reverse().find(x => x.object && x.object.id === aid && x.object.definition);
    return reply(200, { objectType: 'Activity', id: aid, ...(withDef ? { definition: withDef.object.definition } : {}) });
  }
  if (resource === 'agents' && method === 'GET') {
    if (!agentK) return reject(400, '/agents needs an agent parameter.');
    const a = JSON.parse(q.get('agent'));
    const person = { objectType: 'Person' };
    for (const k of ['name', 'mbox', 'mbox_sha1sum', 'openid', 'account']) if (a[k] != null) person[k] = [a[k]];
    return reply(200, person);
  }
  return reject(404, 'Unknown xAPI resource "/' + resource + '".');
}

// Launch parameters for an xAPI activity (the "Tin Can launch" convention used by most authoring tools)
function xapiLaunch(req, res, url) {
  const activityId = url.searchParams.get('activityId') || '';
  if (!lrs.registrations[activityId]) { lrs.registrations[activityId] = crypto.randomUUID(); saveLrs(); }
  const registration = lrs.registrations[activityId];
  launchInfo = { activityId, registration, actorKey: agentKey(LAUNCH_ACTOR) };
  sendJson(res, 200, { endpoint: 'http://' + req.headers.host + '/xapi/', auth: LRS_AUTH, actor: LAUNCH_ACTOR, registration, activityId });
}
// "Reset learner": a fresh registration, and that learner's saved state for the activity removed
function xapiReset(res, url) {
  const activityId = url.searchParams.get('activityId') || '';
  const old = lrs.registrations[activityId];
  for (const k of Object.keys(lrs.docs)) if (k.startsWith('state|' + activityId + '|')) delete lrs.docs[k];
  lrs.registrations[activityId] = crypto.randomUUID();
  saveLrs();
  sendJson(res, 200, { registration: lrs.registrations[activityId], previous: old || null });
}
// What an LMS would show for this registration, worked out from the statements
function xapiSummary(registration) {
  const list = lrs.statements.filter(s => !s.voided && s.context && s.context.registration === registration).sort((a, b) => (a.stored < b.stored ? -1 : 1));
  const vid = s => String((s.verb && s.verb.id) || '').split('/').pop();
  let completion = 'not completed', success = 'unknown', score = null, duration = null;
  for (const s of list) {
    const r = s.result || {};
    if (['completed', 'passed', 'mastered'].includes(vid(s)) || r.completion === true) completion = 'completed';
    // The most recent pass/fail signal wins: a passed/failed verb, or result.success
    if (vid(s) === 'passed') success = 'passed';
    else if (vid(s) === 'failed') success = 'failed';
    else if (r.success === true) success = 'passed';
    else if (r.success === false) success = 'failed';
    if (r.score) score = r.score;
    if (r.duration) duration = r.duration;
  }
  const docs = Object.entries(lrs.docs).filter(([k]) => k.startsWith('state|') && k.split('|')[3] === registration)
    .map(([k, d]) => ({ stateId: k.split('|').slice(4).join('|'), bytes: Buffer.from(d.data, 'base64').length, contentType: d.contentType }));
  return { registration, statements: list.length, completion, success, score, duration,
    lastVerb: list.length ? verbName(list[list.length - 1].verb) : null, recent: list.slice(-5).map(describeStatement), state: docs };
}

async function handleUpload(req, res) {
  const name = decodeURIComponent(String(req.headers['x-filename'] || 'package.zip'));
  await fsp.mkdir(WORK, { recursive: true });
  const tmp = path.join(WORK, 'upload-' + process.pid + '-' + Date.now() + '.zip');
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    await loadPackage(tmp, name);
    sendJson(res, 200, { id: current.id, name: current.name, kind: current.kind });
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
    if (p === '/api/package') return sendJson(res, 200, current ? { id: current.id, name: current.name, kind: current.kind } : { id: null, error: lastError });
    if (url.pathname === '/xapi' || url.pathname.startsWith('/xapi/')) return await handleXapi(req, res, url);
    if (p === '/api/xapi/launch') return xapiLaunch(req, res, url);
    if (p === '/api/xapi/summary') return sendJson(res, 200, xapiSummary(url.searchParams.get('registration') || ''));
    if (p === '/api/xapi/reset' && req.method === 'POST') return xapiReset(res, url);
    if (p === '/api/xapi/events') return xapiEvents(req, res);
    if (p === '/upload' && req.method === 'POST') return await handleUpload(req, res);
    if (p === '/api/close' && req.method === 'POST') { closePackage(); return sendJson(res, 200, { ok: true }); }
    if (p === '/api/criteria') return sendJson(res, 200, completionCriteria() || {});
    if (p === '/api/storyline') {
      if (req.method === 'POST') {
        const q = url.searchParams;
        const bad = (k, ok) => q.has(k) && !ok.includes(q.get(k));
        if (bad('flow', ['free', 'restricted', 'original']) || bad('seekbar', ['unlocked', 'packaged']) || bad('nav', ['unlocked', 'packaged']) || bad('answers', ['preselect', 'packaged']))
          return sendJson(res, 400, { error: 'Use flow=free|restricted|original, seekbar=unlocked|packaged, nav=unlocked|packaged, answers=preselect|packaged' });
        if (q.has('flow')) flowOverride = q.get('flow') === 'original' ? null : q.get('flow');
        if (q.has('seekbar')) seekbarUnlocked = q.get('seekbar') === 'unlocked';
        if (q.has('nav')) navUnlocked = q.get('nav') === 'unlocked';
        if (q.has('answers')) answersPreselected = q.get('answers') === 'preselect';
        if (current) console.log(`Storyline overrides for ${current.name}: navigation ${flowOverride || 'as packaged'}, seekbar ${seekbarUnlocked ? 'unlocked' : 'as packaged'}, Next/Prev ${navUnlocked ? 'unlocked' : 'as packaged'}, quiz answers ${answersPreselected ? 'pre-selected' : 'as packaged'}`);
      }
      return sendJson(res, 200, storylineInfo());
    }
    const m = /^\/pkg\/(\d+)\/(.*)$/.exec(p);
    if (m) {
      if (!current || Number(m[1]) !== current.id) return sendText(res, 404, 'text/plain', 'This package is no longer loaded.');
      const file = path.resolve(current.root, m[2]);
      if (file !== current.root && !file.startsWith(current.root + path.sep)) return sendText(res, 403, 'text/plain', 'Forbidden');
      if (storylineOverrideActive()) {
        const rel = path.relative(current.root, file).split(path.sep).join('/');
        if (isStorylineFile(rel)) return serveStoryline(res, file, rel);
      }
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
  removeOrphanedTempFiles();
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
    console.log(`SCORM Test LMS (SCORM 1.2, SCORM 2004, xAPI) running at ${url}  (Ctrl+C to stop)`);
    if (OPEN) {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  });
})();
