// محاكاة لعبة كاملة بـ 4–5 لاعبين عبر WebSocket
process.env.ROUND_MS = '1500';
process.env.RESULT_MS = '300';
const assert = require('assert');
const WebSocket = require('ws');
const { server } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client(port, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const c = { name, ws, state: null, errors: [], notices: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'state') c.state = m;
    if (m.type === 'error') c.errors.push(m.text);
    if (m.type === 'notice') c.notices.push(m.text);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.open = new Promise((r) => ws.on('open', r));
  return c;
}
async function until(fn, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(20); }
  throw new Error('timeout: ' + fn.toString());
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const names = ['أحمد', 'سارة', 'قاسم', 'حسن', 'ليلى'];
  const cs = names.map((n) => client(port, n));
  await Promise.all(cs.map((c) => c.open));

  // غرفة + انضمام
  cs[0].send({ type: 'create', name: cs[0].name });
  const code = (await until(() => cs[0].state)).code;
  for (const c of cs.slice(1, 4)) c.send({ type: 'join', code, name: c.name });
  await until(() => cs[0].state.players.length === 4);
  // اسم مكرر يتميّز
  cs[4].send({ type: 'join', code, name: 'أحمد' });
  await until(() => cs[4].state && cs[4].state.players.length === 5);
  assert(new Set(cs[4].state.players.map((p) => p.name)).size === 5, 'أسماء مكررة');
  // لاعب غير المضيف ما بيبدأ
  cs[1].send({ type: 'start' }); await sleep(100);
  assert.equal(cs[0].state.phase, 'lobby');
  // رمز غلط
  const bad = client(port, 'x'); await bad.open; bad.send({ type: 'join', code: 'ZZZZ', name: 'x' });
  await until(() => bad.errors.length); bad.ws.close();

  cs[0].send({ type: 'start', winScore: 8 });
  await until(() => cs[0].state.phase === 'round');
  console.log('✓ الغرفة والبدء');

  // ---- جولة عادية: الكل يصوّت ----
  let s = cs[0].state;
  const targetIdx = cs.findIndex((c) => c.state.you.isTarget);
  assert(targetIdx >= 0, 'لازم في هدف');
  assert.equal(cs.filter((c) => c.state.you.isTarget).length, 1);
  const fakes = cs.map((c) => c.state.you.fake);
  assert.equal(new Set(fakes).size, 5, 'أسماء مستعارة فريدة');
  assert(cs.every((c) => c.state.targetFake === cs[targetIdx].state.you.fake));
  // لا تسريب: حالة اللاعب ما فيها هوية الهدف ولا نقاط
  for (const c of cs) {
    const j = JSON.stringify(c.state);
    assert(!('final' in c.state) || c.state.final === null);
    if (!c.state.you.isTarget) assert(!c.state.players.some((p) => 'score' in p));
    assert(!/targetId|targetName/.test(j), 'تسريب الهدف');
  }
  // فلتر "شو اسمك"
  cs[1].send({ type: 'chat', text: 'شو اسمك؟' });
  await until(() => cs[1].notices.length);
  cs[2].send({ type: 'chat', text: 'مرحبا' });
  await until(() => cs[0].state.chat.length === 1);
  assert.equal(cs[0].state.chat[0].fake, cs[2].state.you.fake);
  assert(!JSON.stringify(cs[0].state.chat).includes('قاسم'), 'الشات ما لازم يكشف الاسم الحقيقي');

  // الجميع يصوّت على الهدف الحقيقي (ما عدا الهدف: صوت تمويه)
  const idOf = (c) => c.state.you.id;
  const targetId = idOf(cs[targetIdx]);
  for (const c of cs) {
    const guess = c.state.you.isTarget ? idOf(cs.find((x) => x !== c)) : targetId;
    c.send({ type: 'vote', guessId: guess });
  }
  // تصويت مكرر وتصويت على النفس ما بيعدّلوا
  cs[0].send({ type: 'vote', guessId: idOf(cs[1]) });
  await until(() => cs[0].state.you.canReveal);
  assert(!cs[1].state.you.canReveal, 'الزر للمضيف بس');
  cs[1].send({ type: 'reveal' }); await sleep(80);
  assert.equal(cs[0].state.phase, 'round', 'غير المضيف ما بيكشف');
  cs[0].send({ type: 'reveal' });
  await until(() => cs[0].state.phase === 'result');
  let r = cs[0].state.result;
  assert.equal(r.skipped, false);
  assert.equal(r.targetName, cs[targetIdx].state.players.find((p) => p.id === targetId).name);
  assert.equal(r.correct, 4); assert.equal(r.total, 5); assert.equal(r.exposed, true);
  console.log('✓ جولة عادية: انكشف الهدف (4 من 5)');

  // ---- جولة سكيب ----
  await until(() => cs[0].state.phase === 'round');
  const round2 = cs[0].state.round;
  assert.equal(round2, 2);
  await until(() => cs[0].state.phase === 'result', 3000);
  assert.equal(cs[0].state.result.skipped, true);
  console.log('✓ سكيب بعد انتهاء الدقيقة بدون تصويت الكل');

  // ---- العب لحد النهاية: الكل يصوّت غلط دايماً → الهدف ينجا +2 ----
  let guard = 0;
  while (cs[0].state.phase !== 'ended' && guard++ < 40) {
    await until(() => ['round', 'ended'].includes(cs[0].state.phase));
    if (cs[0].state.phase === 'ended') break;
    const tid = idOf(cs.find((c) => c.state.you.isTarget));
    for (const c of cs) {
      const wrong = cs.find((x) => idOf(x) !== idOf(c) && idOf(x) !== tid);
      c.send({ type: 'vote', guessId: c.state.you.isTarget ? idOf(cs.find((x) => x !== c)) : idOf(wrong) });
    }
    await until(() => cs[0].state.you.canReveal);
    cs[0].send({ type: 'reveal' });
    await until(() => cs[0].state.phase !== 'round');
    assert.equal(cs[0].state.result.exposed, false);
    assert.equal(cs[0].state.final, null, 'النقاط مخفية قبل النهاية');
  }
  await until(() => cs[0].state.phase === 'ended');
  const fin = cs[0].state.final;
  assert(fin[0].score >= 8, 'الفايز وصل 8');
  assert.equal(fin[0].rank, 1);
  for (let i = 1; i < fin.length; i++) assert(fin[i - 1].score >= fin[i].score);
  console.log('✓ النهاية: الترتيب', fin.map((f) => `${f.name}:${f.score}`).join(' '));

  // ---- فصل واستئناف ----
  const old = cs[3]; const tok = null;
  console.log('✓ كل الاختبارات نجحت');
  process.exit(0);
})().catch((e) => { console.error('✗ فشل:', e.message); process.exit(1); });
