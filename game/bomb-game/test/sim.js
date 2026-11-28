// محاكاة لعبة «القنبلة» كاملة عبر WebSocket + فحص بنك الأسئلة
const assert = require('assert');
const path = require('path');
const WebSocket = require('ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadServer(env) {
  for (const k of ['FUSE_MIN_MS', 'FUSE_MAX_MS', 'WRONG_PENALTY_MS', 'GRACE_MS', 'COUNTDOWN_MS', 'BOOM_MS', 'GHOST_MS', 'HAND_MS']) delete process.env[k];
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
    if (m.type === 'react') (c.reacts = c.reacts || []).push(m);
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
  const { QUESTIONS: Qe, HARD: Hd, PUNISHMENTS: P, CATS, GEN_CATS, generate, hashQ } = require('../questions');
  const Q = [...Qe, ...Hd];
  const norm = (s) => s.replace(/[ً-ٟ]/g, '').replace(/[إأآ]/g, 'ا').trim();
  assert(Qe.length >= 800 && Hd.length >= 600, 'لازم 800 سهل و600 صعب: ' + Qe.length + '/' + Hd.length);
  assert(P.length >= 50, 'لازم 50 عقوبة على الأقل');
  assert.equal(new Set(Q.map((x) => norm(x[0]) + '|' + (x[5] || ''))).size, Q.length, 'أسئلة مكررة');
  const LONG = new Set(['history', 'lebanon', 'shia', 'who']); // قصص: لحد 10 كلمات
  for (const x of Q) {
    assert(x.length === 5 || x.length === 6, 'صيغة: ' + x[0]);
    assert(CATS.includes(x[4]), 'فئة غلط: ' + x[0]);
    assert.equal(new Set(x.slice(1, 4)).size, 3, 'خيارات مكررة: ' + x[0]);
    assert(x[0].split(/\s+/).length <= (LONG.has(x[4]) ? 10 : 8), 'سؤال طويل: ' + x[0]);
    if (x[4] === 'pics') assert(x[5], 'سؤال صور بدون صورة: ' + x[0]);
    assert(x.slice(1, 4).every((o) => o.split(/\s+/).length <= 2), 'خيار طويل: ' + x[0]);
  }
  assert.equal(new Set(P).size, P.length, 'عقوبات مكررة');
  for (const c of CATS) assert(Q.filter((x) => x[4] === c).length >= 10, 'فئة قليلة الأسئلة: ' + c);
  // المولّدات: 400 سؤال لكل فئة، كلها سليمة (3 خيارات مختلفة، حدود الكلمات)
  for (const c of GEN_CATS) {
    for (let i = 0; i < 400; i++) {
      const g = generate(c, i % 2 === 0);
      assert(g && g[4] === c, 'مولّد فاشل: ' + c);
      assert.equal(new Set(g.slice(1, 4)).size, 3, 'خيارات مكررة: ' + g.join(' / '));
      assert(g[0].split(/\s+/).length <= 8 && g.slice(1, 4).every((o) => o.split(/\s+/).length <= 2), 'طول: ' + g.join(' / '));
      if (c === 'math') assert(!g.slice(1, 4).some((o) => !/^\d+$/.test(o)), 'حساب: أرقام بس');
      if (c === 'tricky') assert(g.slice(1, 4).every((o) => /\|/.test(o)), 'فخ الألوان لازم خيارات ملوّنة');
    }
  }
  console.log(`✓ بنك الأسئلة: ${Qe.length} سهل/متوسط + ${Hd.length} صعب، و${P.length} عقوبة، سليمين`);

  // ---------- 1) السيرفر الرئيسي ----------
  const s1 = loadServer({ FUSE_MIN_MS: 3500, FUSE_MAX_MS: 3500, WRONG_PENALTY_MS: 500, GRACE_MS: 100, COUNTDOWN_MS: 150, BOOM_MS: 250, GHOST_MS: 400 });
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
  // الحرارة بتنخفى عن الحامل بس (الفتيل 3.5 ث = حرارة قصوى للباقي)
  assert(h.heats.every((l) => l === 0), 'الحامل ما لازم يوصله تسارع: ' + h.heats);
  assert(cs.filter((c) => c !== h).every((c) => c.heats.includes(3)), 'الباقي لازم يحسوا بالحرارة');
  assert(typeof h.state.handEndsAt === 'number' && cs.every((c) => typeof c.state.handEndsAt === 'number'), 'عدّاد الإمساك لازم يظهر للكل');
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
  h.send({ type: 'pass', to: opp.state.you.id, cat: 'geo' });
  await until(() => opp.state.you.isHolder);
  assert.equal(opp.state.q.cat, 'geo', 'الفئة المختارة لازم تطلع للمستلم');
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

  // إحصائيات اللاعب: غلطة وحدة وجواب صح = 50%
  assert.equal(cs[0].state.players.find((x) => x.id === prev.state.you.id).acc, 50, 'نسبة الصح لازم 50%');
  // ردود الفعل: غير الحامل بيقدر، الحامل لأ، وإيموجي غريب ما بينقبل
  const spectator = cs.find((c) => !c.state.you.isHolder);
  const holderNow = holderOf(cs);
  holderNow.send({ type: 'react', emoji: '😂' });
  spectator.send({ type: 'react', emoji: '🤬' });
  spectator.send({ type: 'react', emoji: '😂' });
  spectator.send({ type: 'react', emoji: '🔥' }); // سريع جداً: لازم يتجاهل
  await sleep(150);
  assert.equal((cs[0].reacts || []).length, 1, 'ردود الفعل: واحد بس لازم يوصل');
  assert.equal(cs[0].reacts[0].emoji, '😂');
  assert.equal(cs[0].reacts[0].name, spectator.name);
  console.log('✓ إحصائيات الصح + ردود الفعل (حد أدنى، الحامل ممنوع، إيموجي مقيّد)');

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
  // ذاكرة الأسئلة المشوفة: السيرفر بيفضّل سؤال ما شافه اللاعب
  {
    const sport = [...Qe, ...Hd].filter((x) => x[4] === 'sport');
    const unseen = sport.slice(-3);
    const rm = await makeRoom(port, ['ذ١', 'ذ٢', 'ذ٣', 'ذ٤']);
    const hashes = sport.slice(0, -3).map((x) => hashQ(x));
    rm.cs.forEach((c) => c.send({ type: 'seen', ids: hashes }));
    await sleep(100);
    rm.cs[0].send({ type: 'start', winTarget: 3 });
    await until(() => rm.cs.some((c) => c.state.phase === 'play' && c.state.you.isHolder));
    const hh = holderOf(rm.cs);
    await sleep(350);
    hh.send({ type: 'answer', qid: hh.state.q.id, choice: hh.state.q.debugAnswer });
    await until(() => hh.state.you.mustPass);
    const tg = rm.cs.find((c) => c !== hh);
    hh.send({ type: 'pass', to: tg.state.you.id, cat: 'sport' });
    await until(() => tg.state.you.isHolder);
    assert(unseen.some((x) => x[0] === tg.state.q.text), 'لازم سؤال ما شافه اللاعب: ' + tg.state.q.text);
    rm.cs.forEach((c) => c.ws.close());
    console.log('✓ ذاكرة المشوف: السيرفر بيعطي اللاعب سؤال ما شافه');
  }
  // فئة مولّدة (حساب/إنجليزي/فخاخ): بتطلع أسئلة صحيحة الشكل
  {
    const rm = await makeRoom(port, ['ج١', 'ج٢', 'ج٣', 'ج٤']);
    rm.cs[0].send({ type: 'start', winTarget: 3 });
    await until(() => rm.cs.some((c) => c.state.phase === 'play' && c.state.you.isHolder));
    let cur = holderOf(rm.cs), seenGen = 0;
    for (const cat of ['pics', 'tricky', 'math', 'english', 'pics', 'english', 'math', 'tricky']) {
      await sleep(350);
      cur.send({ type: 'answer', qid: cur.state.q.id, choice: cur.state.q.debugAnswer });
      await until(() => cur.state.you.mustPass, 2500).catch(() => {});
      if (!cur.state.you.mustPass) break;
      const nx = rm.cs.find((c) => c !== cur && c.state.you.id !== cur.state.you.blockedId);
      cur.send({ type: 'pass', to: nx.state.you.id, cat });
      await until(() => nx.state.you.isHolder, 1500);
      assert.equal(nx.state.q.cat, cat, 'الفئة لازم تطلع: ' + cat);
      assert.equal(typeof nx.state.q.h, 'number');
      if (cat === 'pics') assert(nx.state.q.pic, 'سؤال الصور لازم معه صورة');
      seenGen++; cur = nx;
    }
    assert(seenGen >= 4, 'لازم نجرّب كذا فئة مولّدة');
    rm.cs.forEach((c) => c.ws.close());
    console.log('✓ فئات حساب/إنجليزي/ألغاز بتطلع أسئلتها');
  }
  // الغلط بفئة: السؤال اللي بعده من نفس الفئة (لحد ما يجاوب صح)
  for (const cat of ['geo', 'sport', 'math']) {
    const rm = await makeRoom(port, ['ف' + cat, 'ك' + cat, 'ل' + cat, 'م' + cat]);
    rm.cs[0].send({ type: 'start', winTarget: 3 });
    await until(() => rm.cs.some((c) => c.state.phase === 'play' && c.state.you.isHolder));
    const hh = holderOf(rm.cs);
    await sleep(350);
    hh.send({ type: 'answer', qid: hh.state.q.id, choice: hh.state.q.debugAnswer });
    await until(() => hh.state.you.mustPass);
    const tg = rm.cs.find((c) => c !== hh && c.state.you.id !== hh.state.you.blockedId);
    hh.send({ type: 'pass', to: tg.state.you.id, cat });
    await until(() => tg.state.you.isHolder);
    assert.equal(tg.state.q.cat, cat);
    await sleep(350);
    const q0 = tg.state.q;
    tg.send({ type: 'answer', qid: q0.id, choice: (q0.debugAnswer + 1) % 3 });
    await until(() => tg.state.q && tg.state.q.id !== q0.id, 1500);
    assert.equal(tg.state.q.cat, cat, 'بعد الغلط لازم سؤال من نفس الفئة: ' + cat);
    rm.cs.forEach((c) => c.ws.close());
  }
  console.log('✓ الغلط بفئة بيجيب سؤال تاني من نفس الفئة');
  // الأسماء الوهمية: نفس الاسم بيرجع لمكانه، والمنقطع بينشال، و«اطلع من الغرفة» خروج نهائي
  {
    const rm = await makeRoom(port, ['حسن', 'مهدي', 'علي', 'زينب']);
    rm.cs[0].ws.close();
    await until(() => !rm.cs[1].state.players.find((p) => p.name === 'حسن').connected);
    const back = client(port, 'حسن'); await back.open;
    back.send({ type: 'join', code: rm.code, name: 'حسن' });
    await until(() => back.state);
    assert.equal(back.state.players.filter((p) => p.name.startsWith('حسن')).length, 1, 'ما لازم يصير «حسن 2»');
    assert.equal(back.state.players.length, 4);
    rm.cs[1].ws.close(); // مهدي بينقطع وما بيرجع: بينشال بعد GHOST_MS
    await until(() => back.state.players.length === 3, 3000);
    rm.cs[2].send({ type: 'leave' }); // علي بيطلع نهائياً
    await until(() => back.state.players.length === 2, 2000);
    [rm.cs[3], back].forEach((c) => c.ws.close());
    console.log('✓ لا أسماء وهمية: نفس الاسم بيرجع لمكانه، والمنقطع بينشال، والخروج نهائي');
  }
  {
    const rm = await makeRoom(port, ['خ١', 'خ٢', 'خ٣', 'خ٤']);
    rm.cs[0].send({ type: 'start', winTarget: 3 });
    await until(() => rm.cs.some((c) => c.state.phase === 'play' && c.state.you.isHolder));
    const hh = holderOf(rm.cs); const team = hh.state.you.team;
    hh.send({ type: 'leave' });
    const rest = rm.cs.filter((c) => c !== hh);
    await until(() => rest.some((c) => c.state.you.isHolder), 2000);
    assert.equal(holderOf(rest).state.you.team, team, 'القنبلة لزميله');
    assert.equal(rest[0].state.players.length, 3, 'اللي طلع انشال');
    rest.forEach((c) => c.ws.close()); hh.ws.close();
    console.log('✓ خروج الحامل وسط الجولة: القنبلة لزميله وبينشال من الغرفة');
  }
  // الانتقام: اللي انفجرت عنده القنبلة، أول تمريرة له بالجولة الجاية بتعطي المستلم سؤال صعب
  {
    const HARDS = new Set(Hd.map((x) => x[0]));
    const rm = await makeRoom(port, ['ا١', 'ا٢', 'ا٣', 'ا٤']);
    rm.cs[0].send({ type: 'start', winTarget: 5 });
    await until(() => rm.cs.some((c) => c.state.phase === 'play' && c.state.you.isHolder));
    await until(() => rm.cs[0].state.phase === 'boom', 7000);
    const victim = rm.cs.find((c) => c.state.you.name === rm.cs[0].state.result.holderName);
    await until(() => rm.cs[0].state.phase === 'play' && rm.cs.some((c) => c.state.you.isHolder), 4000);
    assert(victim.state.you.revenge, 'اللي انفجرت عنده لازم يكون عنده انتقام');
    assert.equal(rm.cs.filter((c) => c.state.you.revenge).length, 1, 'انتقام لواحد بس');
    const first = holderOf(rm.cs);
    if (first !== victim) {
      await sleep(350);
      first.send({ type: 'answer', qid: first.state.q.id, choice: first.state.q.debugAnswer });
      await until(() => first.state.you.mustPass);
      first.send({ type: 'pass', to: victim.state.you.id });
      await until(() => victim.state.you.isHolder);
    }
    await sleep(350);
    victim.send({ type: 'answer', qid: victim.state.q.id, choice: victim.state.q.debugAnswer });
    await until(() => victim.state.you.mustPass);
    const tgt = rm.cs.find((c) => c !== victim && c.state.you.id !== victim.state.you.blockedId);
    victim.send({ type: 'pass', to: tgt.state.you.id, cat: 'geo' });
    await until(() => tgt.state.you.isHolder);
    assert(HARDS.has(tgt.state.q.text), 'سؤال الانتقام لازم يكون صعب: ' + tgt.state.q.text);
    assert.equal(tgt.state.q.revenge, true);
    assert(!victim.state.you.revenge, 'الانتقام بينصرف مرة وحدة');
    assert(rm.cs[0].state.feed.some((f) => f.includes('انتقام')));
    rm.cs.forEach((c) => c.ws.close());
    console.log('✓ الانتقام: أول تمريرة بعد الانفجار بتعطي المستلم سؤال صعب، ومرة وحدة');
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
  // ---------- 7) حد الإمساك: ما بتقدر تزنخ ----------
  const s3 = loadServer({ FUSE_MIN_MS: 30000, FUSE_MAX_MS: 30000, HAND_MS: 1500, COUNTDOWN_MS: 150, BOOM_MS: 3000 });
  await new Promise((r3) => s3.listen(0, r3));
  const p3 = s3.address().port;
  {
    // حامل ما بيعمل شي: بتنفجر عنده بعد وقت الإمساك (رغم إنو الفتيل 30 ث)
    const { cs: g } = await makeRoom(p3, ['ز١', 'ز٢', 'ز٣', 'ز٤']);
    g[0].send({ type: 'start', winTarget: 3 });
    await until(() => g.some((c) => c.state.phase === 'play' && c.state.you.isHolder));
    const t0 = Date.now();
    const hh = holderOf(g);
    await until(() => g[0].state.phase === 'boom', 4000);
    const dt = Date.now() - t0;
    assert(dt < 3500, 'لازم تنفجر بسرعة بسبب الإمساك: ' + dt);
    assert.equal(g[0].state.result.hold, true, 'لازم السبب «مسكها أكتر من اللازم»');
    assert.equal(g[0].state.result.holderName, hh.name);
    g.forEach((c) => c.ws.close());
    console.log(`✓ حد الإمساك: بعد ${dt}ms انفجرت عند اللي زنخ (مع إنو الفتيل 30 ث)`);
  }
  {
    // التمرير بيعيد عدّاد الإمساك للاعب الجديد
    const { cs: g } = await makeRoom(p3, ['ر١', 'ر٢', 'ر٣', 'ر٤']);
    g[0].send({ type: 'start', winTarget: 3 });
    await until(() => g.some((c) => c.state.phase === 'play' && c.state.you.isHolder));
    const hh = holderOf(g);
    const end1 = hh.state.handEndsAt;
    await sleep(350);
    hh.send({ type: 'answer', qid: hh.state.q.id, choice: hh.state.q.debugAnswer });
    await until(() => hh.state.you.mustPass);
    const nx = g.find((c) => c !== hh);
    hh.send({ type: 'pass', to: nx.state.you.id });
    await until(() => nx.state.you.isHolder);
    assert(nx.state.handEndsAt > end1 + 200, 'عدّاد الإمساك لازم يبدأ من جديد للمستلم');
    await sleep(Math.max(0, end1 + 300 - Date.now())); // بعد وقت الأول بس قبل وقت الجديد
    assert.equal(g[0].state.phase, 'play', 'المستلم الجديد إله وقته');
    g.forEach((c) => c.ws.close());
    console.log('✓ التمرير بيعيد عدّاد الإمساك للمستلم');
  }
  s3.close();
  console.log('✓ كل الاختبارات نجحت');
  process.exit(0);
})().catch((e) => { console.error('✗ فشل:', e.message); process.exit(1); });
