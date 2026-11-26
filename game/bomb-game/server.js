// القنبلة — سيرفر اللعبة (HTTP + WebSocket)
// السيرفر هو الحَكَم الوحيد بالوقت وبالأجوبة الصحيحة، والجوال بس بيعرض.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { QUESTIONS, HARD, PUNISHMENTS, CATS } = require('./questions');

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
const PORT = process.env.PORT || 3000;
const FUSE_MIN = num(process.env.FUSE_MIN_MS, 45000); // فتيل القنبلة المخفي (مشترك بين كل اللاعبين)
const FUSE_MAX = num(process.env.FUSE_MAX_MS, 75000);
const WRONG_PENALTY = num(process.env.WRONG_PENALTY_MS, 3000); // كل غلط بينقص من الفتيل
const GRACE_MS = num(process.env.GRACE_MS, 3000); // ضمان قراءة، مرة وحدة بالجولة
const FREEZE_MS = num(process.env.FREEZE_MS, 1000); // تجميد الأزرار بعد الغلط
const MIN_READ_MS = num(process.env.MIN_READ_MS, 300); // أي جواب أسرع من هيك بيتجاهل
const COUNTDOWN_MS = num(process.env.COUNTDOWN_MS, 3000);
const BOOM_MS = num(process.env.BOOM_MS, 12000);
const TOLERANCE_MS = 250; // تعويض بسيط لتأخر الشبكة
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;
const MAX_ROUNDS = 15;
const MAX_ROOMS = 200;
const WIN_OPTIONS = [3, 5];
const REACTIONS = ['😂', '🔥', '😱', '👏', '💣'];
const HARD_SHARE = 35; // نسبة الأسئلة الصعبة بالمزيج العشوائي (%)
const EXPOSE_ANSWER = process.env.TEST_EXPOSE_ANSWER === '1'; // للاختبارات فقط

const rooms = new Map();

// ---------- أدوات ----------
const rand = (n) => crypto.randomInt(n);
const pick = (a) => a[rand(a.length)];
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const other = (t) => (t === 'A' ? 'B' : 'A');
function genCode() {
  const letters = 'BCDFGHJKLMNPQRSTVWXZ'; // بدون حروف علّة حتى ما تطلع كلمات
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[rand(letters.length)];
    if (!rooms.has(c)) return c;
  }
}
function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
const connected = (room) => room.players.filter((p) => p.connected);
const byId = (room, id) => room.players.find((p) => p.id === id);

// ---------- الفرق ----------
function assignTeams(room, reshuffle) {
  const ps = room.players;
  if (reshuffle) {
    const sh = shuffle(ps);
    let t = rand(2) ? 'A' : 'B';
    sh.forEach((p) => { p.team = t; t = other(t); });
    return;
  }
  const count = (t) => ps.filter((p) => p.team === t).length;
  for (const p of shuffle(ps.filter((x) => !x.team))) p.team = count('A') <= count('B') ? (count('A') === count('B') ? (rand(2) ? 'A' : 'B') : 'A') : 'B';
  for (;;) {
    const a = count('A'), b = count('B');
    if (Math.abs(a - b) <= 1) break;
    const from = a > b ? 'A' : 'B';
    pick(ps.filter((p) => p.team === from)).team = other(from);
  }
}

// ---------- الأسئلة والعقوبات ----------
// بيجيب سؤال من فئة معيّنة (أو عشوائي)، وبيقدر يجبر سؤال صعب (انتقام). ما بيتكرر بنفس الغرفة.
function newQuestion(room, cat, forceHard) {
  const banks = { h: HARD, e: QUESTIONS };
  const wantHard = !!forceHard || rand(100) < HARD_SHARE;
  const order = wantHard ? ['h', 'e'] : ['e', 'h'];
  // محاولات بالترتيب: (الفئة، المطلوب) ثم أي فئة
  const attempts = [];
  for (const t of order) attempts.push([t, cat || null]);
  if (cat) for (const t of order) attempts.push([t, null]);
  let picked = null, tag = 'e';
  for (const [t, c] of attempts) {
    const list = banks[t];
    const idxs = [];
    for (let i = 0; i < list.length; i++) if (!c || list[i][4] === c) idxs.push(i);
    if (!idxs.length) continue;
    let free = idxs.filter((i) => !room.usedQ.has(t + i));
    if (!free.length) { idxs.forEach((i) => room.usedQ.delete(t + i)); free = idxs; }
    const i = pick(free);
    room.usedQ.add(t + i);
    picked = list[i]; tag = t;
    break;
  }
  const [text, right, w1, w2, qcat] = picked;
  const opts = shuffle([right, w1, w2]);
  const now = Date.now();
  room.q = { id: ++room.qSeq, text, options: opts, answerIdx: opts.indexOf(right), shownAt: now, frozenUntil: now, cat: qcat, hard: tag === 'h', revenge: !!forceHard };
  room.awaitingPass = false;
}
function drawPunishment(room) {
  let free = [];
  for (let i = 0; i < PUNISHMENTS.length; i++) if (!room.usedP.has(i)) free.push(i);
  if (!free.length) { room.usedP.clear(); free = PUNISHMENTS.map((_, i) => i); }
  const i = pick(free);
  room.usedP.add(i);
  return PUNISHMENTS[i];
}
function pushFeed(room, text) {
  room.feed.push(text);
  if (room.feed.length > 6) room.feed.shift();
}

// ---------- الحالة ----------
function stateFor(room, p) {
  const isHolder = room.phase === 'play' && room.holderId === p.id;
  const holder = byId(room, room.holderId);
  let q = null;
  if (isHolder && !room.awaitingPass && room.q) {
    q = { id: room.q.id, text: room.q.text, options: room.q.options, cat: room.q.cat, revenge: room.q.revenge, frozenMs: Math.max(0, room.q.frozenUntil - Date.now()) };
    if (EXPOSE_ANSWER) q.debugAnswer = room.q.answerIdx;
  }
  return {
    type: 'state',
    now: Date.now(),
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    round: room.round,
    winTarget: room.winTarget,
    winOptions: WIN_OPTIONS,
    min: MIN_PLAYERS,
    max: MAX_PLAYERS,
    scores: room.scores,
    players: room.players.map((x) => ({ id: x.id, name: x.name, team: x.team, connected: x.connected, acc: x.ok + x.bad ? Math.round((x.ok * 100) / (x.ok + x.bad)) : null, boom: x.boom })),
    you: { id: p.id, name: p.name, team: p.team, isHolder, mustPass: isHolder && room.awaitingPass, blockedId: isHolder ? room.lastFromId : null, revenge: room.phase === 'play' && room.revengeActive === p.id },
    holderId: room.phase === 'play' ? room.holderId : null,
    holderName: room.phase === 'play' && holder ? holder.name : null,
    q,
    heat: room.phase === 'play' ? room.heat : 0,
    feed: room.feed,
    endsAt: room.endsAt,
    result: room.result,
    final: room.phase === 'ended' ? room.final : null,
  };
}
function broadcast(room) {
  for (const p of room.players) if (p.connected) send(p.ws, stateFor(room, p));
}
function notify(room, text) {
  for (const p of connected(room)) send(p.ws, { type: 'notice', text });
}

// ---------- سير اللعبة ----------
function clearAll(room) {
  clearTimeout(room.timer); room.timer = null;
  clearTimeout(room.fuseTimer); room.fuseTimer = null;
  clearInterval(room.tick); room.tick = null;
}

function backToLobby(room, text) {
  clearAll(room);
  room.phase = 'lobby';
  room.round = 0;
  room.holderId = null;
  room.q = null;
  room.awaitingPass = false;
  room.result = null;
  room.endsAt = null;
  room.revengeId = null;
  room.revengeActive = null;
  room.feed = [];
  room.players = room.players.filter((p) => p.connected);
  assignTeams(room, false);
  broadcast(room);
  if (text) notify(room, text);
}

function startGame(room, winTarget) {
  room.players = room.players.filter((p) => p.connected);
  if (room.players.length < MIN_PLAYERS) return false;
  assignTeams(room, false);
  room.winTarget = WIN_OPTIONS.includes(winTarget) ? winTarget : 3;
  room.scores = { A: 0, B: 0 };
  room.round = 0;
  room.replay = false;
  room.final = null;
  room.players.forEach((x) => { x.ok = 0; x.bad = 0; x.boom = 0; });
  room.revengeId = null;
  room.revengeActive = null;
  room.startTeam = rand(2) ? 'A' : 'B';
  startRound(room);
  return true;
}

function startRound(room) {
  clearAll(room);
  const alive = connected(room);
  const teamsOk = ['A', 'B'].every((t) => alive.some((p) => p.team === t));
  if (alive.length < MIN_PLAYERS || !teamsOk) return backToLobby(room, `نزل عدد اللاعبين عن ${MIN_PLAYERS}. رجعنا للوبي 🙏`);
  if (room.replay) room.replay = false;
  else {
    if (room.round > 0) room.startTeam = other(room.startTeam);
    room.round += 1;
    room.revengeActive = room.revengeId; // الانتقام بيشتغل بالجولة اللي بعد الانفجار بس
    room.revengeId = null;
  }
  const pool = alive.filter((p) => p.team === room.startTeam);
  room.holderId = pick(pool.length ? pool : alive).id;
  room.lastFromId = null;
  room.fuse = FUSE_MIN + rand(Math.max(1, FUSE_MAX - FUSE_MIN + 1));
  room.graceUsed = false;
  room.feed = [];
  room.heat = 0;
  room.result = null;
  room.q = null;
  room.awaitingPass = false;
  room.phase = 'countdown';
  room.endsAt = Date.now() + COUNTDOWN_MS;
  room.timer = setTimeout(() => beginPlay(room), COUNTDOWN_MS);
  broadcast(room);
}

function heatLevel(ms) { return ms > 30000 ? 0 : ms > 15000 ? 1 : ms > 6000 ? 2 : 3; }

function beginPlay(room) {
  if (room.phase !== 'countdown') return;
  const h0 = byId(room, room.holderId);
  if (!h0 || !h0.connected) {
    // الحامل انقطع وقت العدّ التنازلي: القنبلة لزميله (أو لأي متصل)
    const alive = connected(room);
    const mates = alive.filter((x) => h0 && x.team === h0.team);
    const pool = mates.length ? mates : alive;
    if (!pool.length) return backToLobby(room, null);
    room.holderId = pick(pool).id;
  }
  room.phase = 'play';
  room.endsAt = null;
  room.explodeAt = Date.now() + room.fuse;
  newQuestion(room);
  scheduleExplode(room);
  room.tick = setInterval(() => {
    if (room.phase !== 'play') return;
    const lvl = heatLevel(room.explodeAt - Date.now());
    if (lvl !== room.heat) {
      room.heat = lvl;
      for (const p of connected(room)) send(p.ws, { type: 'heat', level: lvl });
    }
  }, 300);
  broadcast(room);
}

function scheduleExplode(room) {
  clearTimeout(room.fuseTimer);
  const delay = Math.max(0, room.explodeAt - Date.now()) + TOLERANCE_MS;
  room.fuseTimer = setTimeout(() => explode(room), delay);
}

function explode(room) {
  if (room.phase !== 'play') return;
  clearAll(room);
  const holder = byId(room, room.holderId);
  room.q = null;
  room.awaitingPass = false;
  if (!holder || !holder.connected) {
    // الحامل منقطع: الجولة بتنلغي بدون نقاط وبدون عقوبة وبتنعاد
    room.result = { cancelled: true };
    room.replay = true;
  } else {
    holder.boom += 1;
    room.revengeId = holder.id; // اللي انفجرت عنده بياخد «انتقام» بالجولة الجاية
    const loser = holder.team;
    const winner = other(loser);
    room.scores[winner] += 1;
    room.result = { cancelled: false, holderName: holder.name, loserTeam: loser, winnerTeam: winner, punishment: drawPunishment(room) };
    const reached = room.scores[winner] >= room.winTarget;
    const capped = room.round >= MAX_ROUNDS;
    room.over = reached || capped;
    if (room.over) {
      const { A, B } = room.scores;
      room.final = { winnerTeam: A === B ? 'tie' : A > B ? 'A' : 'B', scores: { A, B }, rounds: room.round };
    }
  }
  room.phase = 'boom';
  room.endsAt = Date.now() + BOOM_MS;
  room.timer = setTimeout(() => afterBoom(room), BOOM_MS);
  broadcast(room);
}

function afterBoom(room) {
  if (room.phase !== 'boom') return;
  clearAll(room);
  if (room.over) {
    room.over = false;
    room.phase = 'ended';
    room.endsAt = null;
    broadcast(room);
  } else startRound(room);
}

function onAnswer(room, p, m) {
  if (room.phase !== 'play' || room.holderId !== p.id || room.awaitingPass || !room.q) return;
  const now = Date.now();
  if (m.qid !== room.q.id || now < room.q.shownAt + MIN_READ_MS || now < room.q.frozenUntil) {
    send(p.ws, stateFor(room, p)); // الجوال ما يضل معطّل لو الضغطة انتجاهلت
    return;
  }
  if (now > room.explodeAt + TOLERANCE_MS) return;
  const choice = Number(m.choice);
  if (![0, 1, 2].includes(choice)) return;
  if (choice === room.q.answerIdx) {
    p.ok += 1;
    room.awaitingPass = true;
    return broadcast(room);
  }
  // غلط: بينقص من الفتيل، وسؤال جديد، وتجميد قصير للأزرار
  p.bad += 1;
  room.explodeAt -= WRONG_PENALTY;
  pushFeed(room, `❌ ${p.name} غلط! −${Math.round(WRONG_PENALTY / 1000)} ثواني`);
  if (room.explodeAt <= now) return explode(room);
  scheduleExplode(room);
  newQuestion(room);
  room.q.frozenUntil = Date.now() + FREEZE_MS;
  broadcast(room);
}

function onPass(room, p, m) {
  if (room.phase !== 'play' || room.holderId !== p.id || !room.awaitingPass) return;
  const target = byId(room, String(m.to || ''));
  if (!target || !target.connected || target.id === p.id) return;
  const options = connected(room).filter((x) => x.id !== p.id);
  const allowed = options.filter((x) => x.id !== room.lastFromId);
  if (!(allowed.length ? allowed : options).some((x) => x.id === target.id)) return;
  const cat = CATS.includes(m.cat) ? m.cat : null;
  const revenge = room.revengeActive === p.id; // أول تمريرة بالانتقام: السؤال الجاي صعب
  if (revenge) room.revengeActive = null;
  room.lastFromId = p.id;
  room.holderId = target.id;
  const mate = target.team === p.team;
  pushFeed(room, `💣 ${p.name} مرّرها ${mate ? 'لزميله' : 'لـ'} ${target.name}${mate ? ' 😈' : ''}${revenge ? ' 😈 انتقام!' : ''}`);
  const now = Date.now();
  if (!room.graceUsed && room.explodeAt - now < GRACE_MS) {
    room.graceUsed = true;
    room.explodeAt = now + GRACE_MS; // ضمان قراءة، مرة وحدة بالجولة
    scheduleExplode(room);
  }
  newQuestion(room, cat, revenge);
  broadcast(room);
}

// ---------- الرسائل ----------
function makePlayer(ws, name) {
  return { id: crypto.randomBytes(6).toString('hex'), token: crypto.randomBytes(16).toString('hex'), name, team: null, ws, connected: true, ok: 0, bad: 0, boom: 0 };
}
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16);
function uniqueName(room, name) {
  let n = name, i = 2;
  while (room.players.some((p) => p.name === n)) n = `${name} ${i++}`;
  return n;
}
function newRoom() {
  const room = {
    code: genCode(), players: [], hostId: null, phase: 'lobby', round: 0, winTarget: 3, scores: { A: 0, B: 0 }, startTeam: 'A',
    holderId: null, lastFromId: null, fuse: 0, explodeAt: 0, graceUsed: false, q: null, qSeq: 0, awaitingPass: false,
    revengeId: null, revengeActive: null, usedQ: new Set(), usedP: new Set(), feed: [], heat: 0, endsAt: null, result: null, final: null, over: false, replay: false,
    timer: null, fuseTimer: null, tick: null, touched: Date.now(),
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
    if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', text: 'السيرفر مشغول، جرّب بعد شوي' });
    const room = newRoom();
    const p = makePlayer(ws, name);
    room.players.push(p);
    room.hostId = p.id;
    assignTeams(room, false);
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
    if (room.players.length >= MAX_PLAYERS) room.players = room.players.filter((x) => x.connected); // ننظّف المنقطعين
    if (room.players.length >= MAX_PLAYERS) return send(ws, { type: 'error', text: 'الغرفة ممتلئة (12 لاعب)' });
    const p = makePlayer(ws, uniqueName(room, name));
    room.players.push(p);
    assignTeams(room, false);
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
  const p = byId(room, ctx.id);
  if (!p) return;
  room.touched = Date.now();
  const lobbyish = room.phase === 'lobby' || room.phase === 'ended';

  if (m.type === 'teams') {
    if (p.id !== room.hostId || !lobbyish) return;
    room.players = room.players.filter((x) => x.connected);
    assignTeams(room, true);
    return broadcast(room);
  }
  if (m.type === 'start') {
    if (p.id !== room.hostId || !lobbyish) return;
    if (connected(room).length < MIN_PLAYERS) return send(ws, { type: 'error', text: `لازم ${MIN_PLAYERS} لاعبين على الأقل` });
    return void startGame(room, Number(m.winTarget));
  }
  if (m.type === 'react') {
    // ردود فعل: بس لغير الحامل أثناء القنبلة، وللكل بعد الانفجار، مع حد أدنى بين الضغطتين
    if (!REACTIONS.includes(m.emoji)) return;
    if (!((room.phase === 'play' && room.holderId !== p.id) || room.phase === 'boom')) return;
    const now = Date.now();
    if (p.lastReact && now - p.lastReact < 500) return;
    p.lastReact = now;
    for (const x of connected(room)) send(x.ws, { type: 'react', emoji: m.emoji, name: p.name });
    return;
  }
  if (m.type === 'answer') return onAnswer(room, p, m);
  if (m.type === 'pass') return onPass(room, p, m);
  if (m.type === 'next') {
    if (p.id !== room.hostId || room.phase !== 'boom') return;
    return afterBoom(room);
  }
}

function onClose(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  const { room } = ctx;
  const p = byId(room, ctx.id);
  if (!p || p.ws !== ws) return;
  p.connected = false;
  room.touched = Date.now();
  if (room.hostId === p.id) {
    const next = connected(room)[0];
    if (next) room.hostId = next.id;
  }
  if (room.phase === 'play' && room.holderId === p.id) {
    // الحامل انقطع: القنبلة بتروح لزميله (أو لأي متصل)
    const mates = connected(room).filter((x) => x.team === p.team);
    const pool = mates.length ? mates : connected(room);
    if (pool.length) {
      const nx = pick(pool);
      room.holderId = nx.id;
      room.lastFromId = null;
      pushFeed(room, `📡 ${p.name} انقطع، القنبلة راحت لـ ${nx.name}`);
      newQuestion(room);
    }
  }
  if ((room.phase === 'play' || room.phase === 'countdown') && ['A', 'B'].some((t) => !connected(room).some((x) => x.team === t))) {
    return backToLobby(room, 'انقطع فريق كامل. رجعنا للوبي 🙏');
  }
  broadcast(room);
}

// ---------- HTTP ----------
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); return res.end('bad request'); }
  if (url.includes('\0')) { res.writeHead(400); return res.end('bad request'); }
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

setInterval(() => {
  // ping كل 5 ثواني، وبنقطع المتصل «الميت» بعد فوتتين (~10 ث) حتى القنبلة ما تعلق عنده
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (connected(room).length === 0 && now - room.touched > 10 * 60 * 1000) {
      clearAll(room);
      rooms.delete(code);
    }
  }
}, 5000).unref();

if (require.main === module) {
  // شبكة أمان: ما نخلّي خطأ غير متوقع يمحي كل الغرف
  process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
  server.listen(PORT, () => console.log(`القنبلة شغّالة على المنفذ ${PORT}`));
}
module.exports = { server };
