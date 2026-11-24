// مين ورا القناع؟ — سيرفر اللعبة (HTTP + WebSocket)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const CARDS = require('./cards');

const PORT = process.env.PORT || 3000;
const ROUND_MS = Number(process.env.ROUND_MS) || 60000;
const RESULT_MS = Number(process.env.RESULT_MS) || 10000;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;
const MAX_ROUNDS = 30;
const WIN_OPTIONS = [8, 10, 12];

const FAKE_WORDS = ['ثعلب', 'صقر', 'نمر', 'غزال', 'دب', 'فهد', 'بومة', 'حوت', 'ذئب', 'نسر', 'قط', 'أسد', 'حمامة', 'جمل', 'فيل', 'زرافة', 'قرش', 'ضفدع', 'نحلة', 'تمساح'];

const rooms = new Map();

// ---------- أدوات ----------
const rand = (n) => crypto.randomInt(n);
const pick = (arr) => arr[rand(arr.length)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function genCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[rand(letters.length)];
    if (!rooms.has(c)) return c;
  }
}
function normalize(s) {
  return s.replace(/[ً-ٟـ]/g, '').replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase();
}
const NAME_ASK = /(شو|ايش|وش|what)\s*(هو\s*)?(اسمك|اسم)|مين\s*(انت|انتي)|your name|who are you/;

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---------- الحالة ----------
function connectedPlayers(room) {
  return room.players.filter((p) => p.connected);
}
function allVoted(room) {
  const req = connectedPlayers(room);
  return req.length > 0 && req.every((p) => p.id in room.votes);
}
function ranking(room) {
  const sorted = room.players.slice().sort((a, b) => b.score - a.score);
  let rank = 0;
  let prev = null;
  return sorted.map((p, i) => {
    if (p.score !== prev) rank = i + 1;
    prev = p.score;
    return { name: p.name, score: p.score, rank };
  });
}

function stateFor(room, p) {
  const req = connectedPlayers(room);
  return {
    type: 'state',
    now: Date.now(),
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    round: room.round,
    winScore: room.winScore,
    winOptions: WIN_OPTIONS,
    min: MIN_PLAYERS,
    max: MAX_PLAYERS,
    you: {
      id: p.id,
      name: p.name,
      fake: room.fake[p.id] || null,
      isTarget: room.phase === 'round' && room.targetId === p.id,
      voted: p.id in room.votes,
      canReveal: room.phase === 'round' && p.id === room.hostId && allVoted(room),
      secretCard: room.phase === 'round' && room.targetId === p.id ? room.secret : null,
    },
    players: room.players.map((x) => ({ id: x.id, name: x.name, connected: x.connected })),
    targetFake: room.phase === 'round' ? room.fake[room.targetId] || null : null,
    card: room.phase === 'round' && room.card ? { type: room.card.type, text: room.card.text.replace('{name}', room.fake[room.targetId] || '') } : null,
    endsAt: room.endsAt,
    votedCount: req.filter((x) => x.id in room.votes).length,
    requiredCount: req.length,
    chat: room.chat.slice(-100),
    result: room.result,
    final: room.phase === 'ended' ? ranking(room) : null,
  };
}

function broadcast(room) {
  for (const p of room.players) if (p.connected) send(p.ws, stateFor(room, p));
}

// ---------- سير اللعبة ----------
function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

// ---------- البطاقات ----------
// بطاقة عامة (موضوع/سؤال) بدون تكرار بنفس اللعبة، ونفس النوع ما بيتكرر جولتين ورا بعض.
function drawCard(room) {
  const types = ['topic', 'ask'];
  const lists = { topic: CARDS.TOPIC, ask: CARDS.ASK };
  let order = shuffle(types);
  if (room.lastCardType) order = [...order.filter((t) => t !== room.lastCardType), ...order.filter((t) => t === room.lastCardType)];
  for (let pass = 0; pass < 2; pass++) {
    for (const t of order) {
      const free = lists[t].map((text, i) => ({ text, key: `${t}:${i}` })).filter((c) => !room.usedCards.has(c.key));
      if (free.length) {
        const c = pick(free);
        room.usedCards.add(c.key);
        room.lastCardType = t;
        return { type: t, text: c.text };
      }
    }
    room.usedCards.clear(); // خلصت البطاقات: نبدأ من جديد
  }
}
function drawSecret(room) {
  let free = CARDS.SECRET.map((text, i) => ({ text, key: `s:${i}` })).filter((c) => !room.usedCards.has(c.key));
  if (!free.length) {
    CARDS.SECRET.forEach((_, i) => room.usedCards.delete(`s:${i}`));
    free = CARDS.SECRET.map((text, i) => ({ text, key: `s:${i}` }));
  }
  const c = pick(free);
  room.usedCards.add(c.key);
  return c.text;
}

function startGame(room, winScore) {
  room.players = room.players.filter((p) => p.connected);
  room.players.forEach((p) => (p.score = 0));
  room.winScore = WIN_OPTIONS.includes(winScore) ? winScore : 10;
  room.round = 0;
  room.over = false;
  room.result = null;
  room.usedCards = new Set();
  room.lastCardType = null;
  startRound(room);
}

function startRound(room) {
  clearTimer(room);
  const alive = connectedPlayers(room);
  room.round += 1;
  room.targetId = pick(alive).id; // عشوائي من الكل، التكرار مسموح
  const used = new Set();
  room.fake = {};
  for (const p of shuffle(room.players)) {
    let name;
    do name = `${pick(FAKE_WORDS)}_${10 + rand(90)}`;
    while (used.has(name));
    used.add(name);
    room.fake[p.id] = name;
  }
  room.votes = {};
  room.chat = [];
  room.result = null;
  room.card = drawCard(room);
  room.secret = drawSecret(room);
  room.phase = 'round';
  room.endsAt = Date.now() + ROUND_MS;
  room.timer = setTimeout(() => reveal(room), ROUND_MS);
  broadcast(room);
}

function reveal(room) {
  if (room.phase !== 'round') return;
  clearTimer(room);
  const target = room.players.find((p) => p.id === room.targetId);
  if (!target || !target.connected) {
    // الهدف انقطع: الجولة بتنلغي بدون نقاط لأي حدا
    room.result = { cancelled: true };
  } else if (allVoted(room)) {
    const voters = connectedPlayers(room);
    const total = voters.length;
    const correct = voters.filter((p) => room.votes[p.id] === room.targetId);
    const exposed = correct.length * 2 > total;
    correct.forEach((p) => (p.score += 1));
    if (!exposed && target) target.score += 2;
    room.result = {
      skipped: false,
      targetName: target ? target.name : '؟',
      targetFake: room.fake[room.targetId],
      exposed,
      correct: correct.length,
      total,
    };
  } else {
    if (target && target.connected) target.score += 1; // بونس السكيب (مخفي)، بس إذا الهدف موجود
    room.result = { skipped: true };
  }
  room.over = room.players.some((p) => p.score >= room.winScore) || room.round >= MAX_ROUNDS;
  room.phase = 'result';
  room.endsAt = Date.now() + RESULT_MS;
  room.timer = setTimeout(() => afterResult(room), RESULT_MS);
  broadcast(room);
}

function afterResult(room) {
  clearTimer(room);
  if (room.over) {
    room.phase = 'ended';
    room.endsAt = null;
    broadcast(room);
  } else if (connectedPlayers(room).length < MIN_PLAYERS) {
    // نزل عدد المتصلين عن الحد الأدنى: منرجع للوبي ومنستنى اللاعبين
    room.phase = 'lobby';
    room.endsAt = null;
    room.result = null;
    broadcast(room);
    for (const p of connectedPlayers(room)) send(p.ws, { type: 'notice', text: `نزل عدد اللاعبين عن ${MIN_PLAYERS}. رجعنا للوبي 🙏` });
  } else startRound(room);
}

// ---------- الرسائل ----------
function makePlayer(ws, name) {
  return { id: crypto.randomBytes(6).toString('hex'), token: crypto.randomBytes(16).toString('hex'), name, ws, connected: true, score: 0 };
}
function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16);
}
function uniqueName(room, name) {
  let n = name;
  let i = 2;
  while (room.players.some((p) => p.name === n)) n = `${name} ${i++}`;
  return n;
}
function newRoom() {
  const room = {
    code: genCode(), players: [], hostId: null, phase: 'lobby', round: 0, winScore: 10, targetId: null,
    fake: {}, votes: {}, chat: [], endsAt: null, timer: null, result: null, over: false, touched: Date.now(),
    chatSeq: 0, card: null, secret: null, usedCards: new Set(), lastCardType: null,
  };
  rooms.set(room.code, room);
  return room;
}

function onMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.type !== 'string') return;

  if (m.type === 'create') {
    const name = cleanName(m.name);
    if (!name) return send(ws, { type: 'error', text: 'اكتب اسمك' });
    const room = newRoom();
    const p = makePlayer(ws, name);
    room.players.push(p);
    room.hostId = p.id;
    ws.ctx = { room, id: p.id };
    send(ws, { type: 'joined', code: room.code, token: p.token });
    return broadcast(room);
  }

  if (m.type === 'join') {
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    const name = cleanName(m.name);
    if (!name) return send(ws, { type: 'error', text: 'اكتب اسمك' });
    if (!room) return send(ws, { type: 'error', text: 'ما في غرفة بهالرمز' });
    if (room.phase !== 'lobby' && room.phase !== 'ended') return send(ws, { type: 'error', text: 'اللعبة بدأت بهالغرفة' });
    if (room.players.length >= MAX_PLAYERS) return send(ws, { type: 'error', text: 'الغرفة ممتلئة (12 لاعب)' });
    const p = makePlayer(ws, uniqueName(room, name));
    room.players.push(p);
    ws.ctx = { room, id: p.id };
    room.touched = Date.now();
    send(ws, { type: 'joined', code: room.code, token: p.token });
    return broadcast(room);
  }

  if (m.type === 'resume') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    const p = room && room.players.find((x) => x.token === m.token);
    if (!p) return send(ws, { type: 'gone' });
    if (p.ws && p.ws !== ws) { p.ws.ctx = null; try { p.ws.close(); } catch {} }
    p.ws = ws;
    p.connected = true;
    ws.ctx = { room, id: p.id };
    send(ws, { type: 'joined', code: room.code, token: p.token });
    return broadcast(room);
  }

  const ctx = ws.ctx;
  if (!ctx) return;
  const { room } = ctx;
  const p = room.players.find((x) => x.id === ctx.id);
  if (!p) return;
  room.touched = Date.now();

  if (m.type === 'start') {
    if (p.id !== room.hostId || (room.phase !== 'lobby' && room.phase !== 'ended')) return;
    if (connectedPlayers(room).length < MIN_PLAYERS) return send(ws, { type: 'error', text: `لازم ${MIN_PLAYERS} لاعبين على الأقل` });
    return startGame(room, Number(m.winScore));
  }

  if (m.type === 'chat') {
    if (room.phase !== 'round') return;
    const text = String(m.text || '').trim().slice(0, 200);
    if (!text) return;
    const now = Date.now();
    if (p.lastChat && now - p.lastChat < 400) return;
    p.lastChat = now;
    if (NAME_ASK.test(normalize(text))) return send(ws, { type: 'notice', text: 'ممنوع تسأل عن الاسم الحقيقي مباشرة 🙅' });
    room.chat.push({ n: ++room.chatSeq, fake: room.fake[p.id], text, t: now });
    return broadcast(room);
  }

  if (m.type === 'vote') {
    if (room.phase !== 'round' || p.id in room.votes) return;
    const g = String(m.guessId || '');
    if (g === p.id || !room.players.some((x) => x.id === g)) return;
    room.votes[p.id] = g;
    return broadcast(room);
  }

  if (m.type === 'reveal') {
    if (p.id !== room.hostId || room.phase !== 'round' || !allVoted(room)) return;
    return reveal(room);
  }
}

function onClose(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  const { room } = ctx;
  const p = room.players.find((x) => x.id === ctx.id);
  if (!p || p.ws !== ws) return;
  p.connected = false;
  room.touched = Date.now();
  if (room.hostId === p.id) {
    const next = connectedPlayers(room)[0];
    if (next) room.hostId = next.id;
  }
  broadcast(room);
}

// ---------- HTTP ----------
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (d) => onMessage(ws, d.toString()));
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});

// نبض للاتصالات + تنظيف الغرف المهجورة
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (connectedPlayers(room).length === 0 && now - room.touched > 10 * 60 * 1000) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 30000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`مين ورا القناع؟ شغّال على المنفذ ${PORT}`));
}
module.exports = { server };
