// محاكاة لعبة «القنبلة» كاملة عبر WebSocket + فحص بنك الأسئلة
const assert = require('assert');
const path = require('path');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadServer(env) {
  for (const k of ['FUSE_MIN_MS', 'FUSE_MAX_MS', 'WRONG_PENALTY_MS', 'GRACE_MS', 'COUNTDOWN_MS', 'BOOM_MS']) delete process.env[k];
  Object.assign(process.env, { TEST_EXPOSE_ANSWER: '1' }, env);
  delete require.cache[require.resolve('../server')];
  return require('../server').server;
}
function client(port, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const c = { name, ws, state: null, errors: [], notices: [], heats: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'state') { c.state = m; c.stateCount = (c.stateCount || 0) + 1; }
    if (m.type === 'error') c.errors.push(m.text);
    if (m.type === 'notice') c.notices.push(m.text);
    if (m.type === 'heat') c.heats.push(m.level);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.open = new Promise((r) => ws.on('open', r));
  return c;
}
async function until(fn, ms = 6000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(15); }
  throw new Error('timeout: ' + fn.toString().slice(0, 120));
}
async function makeRoom(port, names) {
  const cs = names.map((n) => client(port, n));
  await Promise.all(cs.map((c) => c.open));
  cs[0].send({ type: 'create', name: names[0] });
  const code = (await until(() => cs[0].state)).code;
  for (const c of cs.slice(1)) c.send({ type: 'join', code, name: c.name });
  await until(() => cs[0].state.players.length === names.length);
  return { cs, code };
}
const holderOf = (cs) => cs.find((c) => c.state.you.isHolder);

(async () => {
  // ---------- 0) بنك الأسئلة ----------
  const { QUESTIONS: Qe, HARD: Hd, PUNISHMENTS: P } = require('../questions');
  const Q = [...Qe, ...Hd];
  const norm = (s) => s.replace(/[ً-ٟ]/g, '').replace(/[إأآ]/g, 'ا').trim();
  assert(Qe.length >= 300 && Hd.length >= 120, 'لازم 300 سهل و120 صعب: ' + Qe.length + '/' + Hd.length);
  assert(P.length >= 50, 'لازم 50 عقوبة على الأقل');
  assert.equal(new Set(Q.map((x) => norm(x[0]))).size, Q.length, 'أسئلة مكررة');
  for (const x of Q) {
    assert.equal(x.length, 4, 'صيغة: ' + x[0]);
    assert.equal(new Set(x.slice(1)).size, 3, 'خيارات مكررة: ' + x[0]);
    assert(x[0].split(/\s+/).length <= 8, 'سؤال طويل: ' + x[0]);
    assert(x.slice(1).every((o) => o.split(/\s+/).length <= 2), 'خيار طويل: ' + x[0]);
  }
  assert.equal(new Set(P).size, P.length, 'عقوبات مكررة');
  console.log(`✓ بنك الأسئلة: ${Qe.length} سهل/متوسط + ${Hd.length} صعب، و${P.length} عقوبة، سليمين`);

  // ---------- 1) السيرفر الرئيسي ----------
  const s1 = loadServer({ FUSE_MIN_MS: 3500, FUSE_MAX_MS: 3500, WRONG_PENALTY_MS: 500, GRACE_MS: 100, COUNTDOWN_MS: 150, BOOM_MS: 250 });
  await new Promise((r) => s1.listen(0, r));
  const port = s1.address().port;
  const { cs, code } = await makeRoom(port, ['أحمد', 'سارة', 'قاسم', 'حسن']);
  assert(!/[AEIOU]/.test(code), 'رمز الغرفة فيه حرف علّة: ' + code);
  const teamCount = (t) => cs[0].state.players.filter((p) => p.team === t).length;
  assert.equal(teamCount('A'), 2); assert.equal(teamCount('B'), 2);
  // غير المضيف ما بيبدأ
  cs[1].send({ type: 'start' }); await sleep(100);
  assert.equal(cs[0].state.phase, 'lobby');
  // لاعب خامس: فريق 3/2
  const five = client(port, 'ليلى'); await five.open; five.send({ type: 'join', code, name: 'ليلى' });
  await until(() => cs[0].state.players.length === 5);
  assert.equal(Math.abs(teamCount('A') - teamCount('B')), 1);
  five.ws.close(); await until(() => !cs[0].state.players.find((p) => p.name === 'ليلى').connected);
  cs[0].send({ type: 'teams' }); await sleep(80);
  console.log('✓ الغرفة، الفرق (2/2 و3/2)، وإعادة التوزيع');

  cs[0].send({ type: 'start', winTarget: 3 });
  await until(() => cs[0].state.phase === 'countdown');
  assert(cs[0].state.players.length === 4, 'اللاعب المنقطع انشال');
  await until(() => cs[0].state.phase === 'play');
  await until(() => cs.some((c) => c.state.you.isHolder));
  const firstTeams = [];
  let rounds = [];

  // ---------- 2) الأسئلة والتصحيح والتمرير ----------
  let h = holderOf(cs);
  rounds.push(h.state.you.team);
  assert.equal(cs.filter((c) => c.state.you.isHolder).length, 1);
  for (const c of cs) {
    if (c === h) { assert(c.state.q && c.state.q.options.length === 3); }
    else assert.equal(c.state.q, null, 'غير الحامل ما بيشوف السؤال');
    assert(!JSON.stringify(c.state).includes('answerIdx'), 'تسريب الجواب');
  }
  // جواب أسرع من 300ms ما بينقبل
  h.send({ type: 'answer', qid: h.state.q.id, choice: h.state.q.debugAnswer });
  await sleep(100);
  assert(!h.state.you.mustPass, 'جواب سريع لازم يتجاهل');
  await sleep(300);
  // غلط: سؤال جديد + feed + تجميد
  const q1 = h.state.q;
  h.send({ type: 'answer', qid: q1.id, choice: (q1.debugAnswer + 1) % 3 });
  await until(() => h.state.q && h.state.q.id !== q1.id);
  assert(h.state.q.frozenMs > 0, 'لازم تجميد بعد الغلط');
  assert(cs[0].state.feed.some((f) => f.includes('غلط')), 'feed لازم يذكر الغلط');
  await sleep(1050);
  // صح: لازم يمرّر
  const q2 = h.state.q;
  h.send({ type: 'answer', qid: q2.id, choice: q2.debugAnswer });
  await until(() => h.state.you.mustPass);
  // تمرير لنفسه ما بيمرّ
  h.send({ type: 'pass', to: h.state.you.id }); await sleep(80);
  assert(h.state.you.mustPass, 'تمرير لنفسك مرفوض');
  const prev = h;
  const opp = cs.find((c) => c.state.you.team !== h.state.you.team);
  h.send({ type: 'pass', to: opp.state.you.id });
  await until(() => opp.state.you.isHolder);
  assert(!prev.state.you.isHolder);
  assert(cs[0].state.feed.some((f) => f.includes('مرّرها')));
  // ما بتقدر ترجّعها فوراً لللي مرّرها لك
  await sleep(350);
  opp.send({ type: 'answer', qid: opp.state.q.id, choice: opp.state.q.debugAnswer });
  await until(() => opp.state.you.mustPass);
  assert.equal(opp.state.you.blockedId, prev.state.you.id);
  opp.send({ type: 'pass', to: prev.state.you.id }); await sleep(80);
  assert(opp.state.you.isHolder, 'ممنوع الرجوع فوراً للي مرّرها');
  console.log('✓ سؤال، تصحيح، غلط (سؤال جديد + تجميد)، تمرير، ومنع الرجوع الفوري');

  // ---------- 3) الانفجار ----------
  await until(() => cs[0].state.phase === 'boom', 7000);
  let r = cs[0].state.result;
  assert.equal(r.cancelled, false);
  const sc = cs[0].state.scores;
  assert.equal(sc[r.winnerTeam], 1); assert.equal(sc[r.loserTeam], 0);
  assert(r.punishment && r.holderName);
  console.log(`✓ انفجار: ${r.holderName} خسّر فريقه، النقطة للفريق التاني، عقوبة: «${r.punishment}»`);

  // ---------- 4) جولات بدون تدخل: تبديل الفريق البادئ + النهاية ----------
  let guard = 0;
  while (cs[0].state.phase !== 'ended' && guard++ < 20) {
    await until(() => ['play', 'ended'].includes(cs[0].state.phase), 7000);
    if (cs[0].state.phase === 'ended') break;
    await until(() => cs.some((c) => c.state.you.isHolder));
    rounds.push(holderOf(cs).state.you.team);
    await until(() => ['boom', 'ended'].includes(cs[0].state.phase), 7000);
  }
  await until(() => cs[0].state.phase === 'ended', 7000);
  const fin = cs[0].state.final;
  assert(fin.scores[fin.winnerTeam] >= 3, 'الفايز وصل 3');
  for (let i = 1; i < rounds.length; i++) assert.notEqual(rounds[i], rounds[i - 1], 'الفريق البادئ لازم يتبدّل كل جولة: ' + rounds.join(''));
  console.log(`✓ نهاية المباراة ${fin.scores.A}-${fin.scores.B} بعد ${fin.rounds} جولات، والفريق البادئ بيتبدّل: ${rounds.join('')}`);
  assert(cs.some((c) => c.heats.length > 0), 'لازم تتوصل رسائل heat');

  // لعب من جديد
  cs[0].send({ type: 'teams' }); cs[0].send({ type: 'start', winTarget: 3 });
  await until(() => cs[0].state.phase === 'countdown');
  console.log('✓ لعب من جديد');
  await until(() => cs[0].state.phase === 'play');

  // ---------- 5) انقطاع الحامل: القنبلة لزميله ----------
  const room2 = await makeRoom(port, ['أ', 'ب', 'ج', 'د']);
  room2.cs[0].send({ type: 'start', winTarget: 3 });
  await until(() => room2.cs[0].state.phase === 'play');
  await until(() => room2.cs.some((c) => c.state.you.isHolder));
  const dead = holderOf(room2.cs);
  const deadTeam = dead.state.you.team;
  dead.ws.close();
  const alive = room2.cs.filter((c) => c !== dead);
  await until(() => alive.some((c) => c.state.you.isHolder), 2000);
  const nh = holderOf(alive);
  assert.equal(nh.state.you.team, deadTeam, 'القنبلة لازم تروح لزميله');
  console.log('✓ انقطاع الحامل: القنبلة راحت لزميله');
  // الفريق ما ضلّ منه حدا: بيرجع للوبي
  const mates = alive.filter((c) => c.state.you.team === deadTeam);
  mates.forEach((c) => c.ws.close());
  const rest = alive.filter((c) => c.state.you.team !== deadTeam);
  await until(() => rest[0].state.phase === 'lobby', 2000);
  console.log('✓ انقطع فريق كامل: رجوع للوبي');
  // ---------- 5ب) إصلاحات تدقيق جلسة 3 ----------
  // HTTP: طلبات خربانة ما بتقتل السيرفر
  const http = require('http');
  const get = (u) => new Promise((res, rej) => http.get(`http://127.0.0.1:${port}${u}`, (r) => { r.resume(); res(r.statusCode); }).on('error', rej));
  assert.equal(await get('/%'), 400);
  assert.equal(await get('/a%00b'), 400);
  assert.equal(await get('/healthz'), 200);
  console.log('✓ طلبات HTTP خربانة ما بتوقّع السيرفر');
  // الحامل ينقطع وقت العدّ التنازلي: لازم يتحوّل لمتصل
  for (let i = 0; i < 4; i++) {
    const rm = await makeRoom(port, ['و' + i, 'ز' + i, 'ح' + i, 'ط' + i]);
    rm.cs[0].send({ type: 'start', winTarget: 3 });
    await until(() => rm.cs.some((c) => c.state && c.state.phase === 'countdown'));
    rm.cs[i].ws.close();
    const left = rm.cs.filter((_, j) => j !== i);
    await until(() => left.some((c) => c.state.phase === 'play' && c.state.you.isHolder) || left.some((c) => c.state.phase === 'lobby'), 3000);
    if (left.some((c) => c.state.phase === 'play')) assert.equal(left.filter((c) => c.state.you.isHolder).length, 1, 'لازم حامل متصل');
    left.forEach((c) => c.ws.close());
  }
  console.log('✓ انقطاع أي لاعب وقت العدّ التنازلي: القنبلة ما بتعلق عند منقطع');
  // جواب مبكر بينتجاهل بس الجوال بيتحدّث (ما بيضل معطّل)
  {
    const rm = await makeRoom(port, ['ر١', 'ر٢', 'ر٣', 'ر٤']);
    rm.cs[0].send({ type: 'start', winTarget: 3 });
    await until(() => rm.cs.some((c) => c.state.phase === 'play' && c.state.you.isHolder));
    const hh = holderOf(rm.cs);
    const before = hh.stateCount;
    hh.send({ type: 'answer', qid: hh.state.q.id, choice: 0 });
    await until(() => hh.stateCount > before, 800);
    assert(hh.state.q, 'السؤال لازم يضل قدامه');
    rm.cs.forEach((c) => c.ws.close());
    console.log('✓ جواب مبكر بينتجاهل والجوال بيتحدّث (ما بيتجمّد)');
  }
  // لاعبين منقطعين ما بيحجزوا مقاعد الغرفة
  {
    const names = Array.from({ length: 12 }, (_, i) => 'ل' + i);
    const rm = await makeRoom(port, names);
    rm.cs.slice(9).forEach((c) => c.ws.close());
    await until(() => rm.cs[0].state.players.filter((p) => p.connected).length === 9);
    const nw = client(port, 'جديد'); await nw.open;
    nw.send({ type: 'join', code: rm.code, name: 'جديد' });
    await until(() => nw.state || nw.errors.length);
    assert.equal(nw.errors.length, 0, 'ما لازم تنرفض: ' + nw.errors);
    rm.cs.forEach((c) => c.ws.close()); nw.ws.close();
    console.log('✓ المنقطعين ما بيحجزوا مقاعد الغرفة الممتلئة');
  }
  s1.close();

  // ---------- 6) سيرفر ثاني: الضمان المرة وحدة + الغلط بيفجّر لو الفتيل قصير ----------
  const s2 = loadServer({ FUSE_MIN_MS: 800, FUSE_MAX_MS: 800, WRONG_PENALTY_MS: 5000, GRACE_MS: 2000, COUNTDOWN_MS: 150, BOOM_MS: 4000 });
  await new Promise((r2) => s2.listen(0, r2));
  const p2 = s2.address().port;
  {
    const { cs: g } = await makeRoom(p2, ['١', '٢', '٣', '٤']);
    g[0].send({ type: 'start', winTarget: 3 });
    await until(() => g.some((c) => c.state && c.state.you.isHolder && c.state.phase === 'play'));
    let hh = holderOf(g);
    await sleep(350);
    hh.send({ type: 'answer', qid: hh.state.q.id, choice: hh.state.q.debugAnswer });
    await until(() => hh.state.you.mustPass);
    const tgt = g.find((c) => c !== hh);
    const t0 = Date.now();
    hh.send({ type: 'pass', to: tgt.state.you.id });
    await until(() => tgt.state.you.isHolder);
    // الفتيل (800ms) كان قرّب يخلص: الضمان بيمدّد 2 ثانية
    await sleep(1200);
    assert.equal(g[0].state.phase, 'play', 'الضمان لازم يبقيها شغالة');
    await until(() => g[0].state.phase === 'boom', 3500);
    assert(Date.now() - t0 > 1500, 'الضمان لازم يعطي وقت');
    console.log('✓ ضمان القراءة (مرة وحدة) شغّال');
  }
  {
    await sleep(100);
    const { cs: g } = await makeRoom(p2, ['٥', '٦', '٧', '٨']);
    g[0].send({ type: 'start', winTarget: 3 });
    await until(() => g.some((c) => c.state && c.state.you.isHolder && c.state.phase === 'play'));
    const hh = holderOf(g);
    await sleep(320);
    hh.send({ type: 'answer', qid: hh.state.q.id, choice: (hh.state.q.debugAnswer + 1) % 3 });
    await until(() => g[0].state.phase === 'boom', 1500);
    assert.equal(g[0].state.result.holderName, hh.name);
    console.log('✓ الغلط (−3 ث) على فتيل قصير بيفجّرها فوراً');
  }
  s2.close();
  console.log('✓ كل الاختبارات نجحت');
  process.exit(0);
})().catch((e) => { console.error('✗ فشل:', e.message); process.exit(1); });
