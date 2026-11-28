// غرفة الأساتذة: 9 أبواب، كل باب أستاذ لمادة، ومحادثاته منفصلة.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ACCESS_CODE = process.env.ACCESS_CODE || ''; // اختياري: رمز دخول يحمي مفتاحك
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';

const BASE = `إنت أستاذ جامعي صبور وممتاز عم يشرح لطالب لحاله. احكي بلهجة شامية بسيطة وواضحة، وخلّي المصطلحات التقنية بالإنجليزي. اشرح خطوة خطوة، أعطي أمثلة عملية، وبعد كل شرح اسأل الطالب سؤال صغير تتأكد إنه فهم. إذا ما كان الطالب فاهم، بسّط أكتر وبدّل المثال. بآخر الجلسة اعرض له أسئلة تشبه أسئلة الامتحان لما يطلب. الطالب مش مبرمج بالأصل فلا تفترض معرفة سابقة إلا إذا قال هو. ردودك مرتبة وقصيرة قد ما بتسمح المادة. هي المحادثة مستقلة تماماً: لا تفترض إنك حكيت معه عن مواد تانية.`;

const SUBJECTS = {
  db:   { name: 'قواعد المعطيات المتطورة (Advanced Databases)', who: 'د. حسن بهجة' },
  dss:  { name: 'أنظمة اتخاذ القرار (DSS)', who: 'د. حسن بهجة' },
  net:  { name: 'حماية الشبكات ونظم هيكلية (Network Security)', who: 'د. حسن فقيه' },
  xml:  { name: 'XML', who: 'د. علي سالم' },
  java: { name: 'Java Applet', who: 'د. علي سالم' },
  web:  { name: 'JavaScript + SQL + PHP', who: 'د. علي سالم' },
  law:  { name: 'التنظيم القانوني للمعاملات (الإلكترونية)', who: 'د. قاسم قديح' },
  uml:  { name: 'طرائق موجّهة الهدف (UML)', who: 'د. نعمت حلال' },
  mob:  { name: 'تطبيق الهواتف الذكية (Mobile Apps)', who: 'د. رضا هاشم' },
};

function systemFor(id) {
  const s = SUBJECTS[id];
  return `${BASE}\n\nمادتك: ${s.name}. إنت بدور ${s.who}. ركّز فقط على هالمادة.`;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function chat(req, res) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 400000) return send(res, 413, { error: 'كبير كتير' }); }
  let b;
  try { b = JSON.parse(raw); } catch { return send(res, 400, { error: 'طلب غلط' }); }
  if (ACCESS_CODE && b.code !== ACCESS_CODE) return send(res, 401, { error: 'الرمز غلط' });
  if (!API_KEY) return send(res, 500, { error: 'مفتاح Anthropic ناقص بالسيرفر' });
  if (!SUBJECTS[b.subject]) return send(res, 400, { error: 'مادة مجهولة' });
  const msgs = (Array.isArray(b.messages) ? b.messages : [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
    .slice(-40);
  if (!msgs.length || msgs[0].role !== 'user') return send(res, 400, { error: 'رسالة ناقصة' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: systemFor(b.subject), messages: msgs }),
    });
    const j = await r.json();
    if (!r.ok) return send(res, 502, { error: (j.error && j.error.message) || 'خطأ من Anthropic' });
    const text = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
    send(res, 200, { text });
  } catch (e) {
    send(res, 502, { error: 'تعذّر الاتصال: ' + e.message });
  }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') return send(res, 200, 'ok', 'text/plain');
  if (url === '/api/info') return send(res, 200, { needCode: !!ACCESS_CODE, hasKey: !!API_KEY });
  if (url === '/api/chat' && req.method === 'POST') return chat(req, res);
  if (url === '/' || url === '/index.html')
    return fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) =>
      e ? send(res, 500, 'خطأ', 'text/plain') : send(res, 200, d, 'text/html; charset=utf-8'));
  send(res, 404, 'مش موجود', 'text/plain');
});
server.listen(PORT, () => console.log('teachers room on ' + PORT));
