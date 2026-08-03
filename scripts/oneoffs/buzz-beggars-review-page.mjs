/**
 * Renders results.jsonl into a single self-contained review page.
 *
 *   node scripts/oneoffs/buzz-beggars-review-page.mjs [--out path.html]
 *
 * Thumbnails load from the Civitai CDN, so the page needs a network connection but no server.
 * Agree/disagree marks are kept in localStorage and can be exported as JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '.buzz-beggars');
const RESULTS_FILE = process.env.RESULTS_FILE || path.join(OUT_DIR, 'results.jsonl');
const CDN = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA';

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const outFile = argValue('--out') ?? path.join(OUT_DIR, 'review.html');

const onlyIds = argValue('--only-ids');
const idFilter = onlyIds ? new Set(onlyIds.split(',').map(Number)) : null;

const rows = [
  ...new Map(
    fs
      .readFileSync(RESULTS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((r) => [r.imageId, r])
  ).values(),
].filter((r) => !idFilter || idFilter.has(r.imageId));

const thumb = (r) =>
  `${CDN}/${r.url}/${r.type === 'video' ? 'anim=false,transcode=true,' : ''}width=350/x.jpeg`;

const counts = rows.reduce((acc, r) => ((acc[r.decision] = (acc[r.decision] ?? 0) + 1), acc), {});
const allViolations = [
  ...new Set(rows.flatMap((r) => [...(r.violations ?? []), ...(r.escalations ?? [])])),
].sort();

const payload = rows.map((r) => ({
  id: r.imageId,
  ci: r.ciId,
  src: thumb(r),
  full: `https://civitai.com/images/${r.imageId}`,
  d: r.decision,
  v: [...(r.escalations ?? []), ...(r.violations ?? [])],
  reason: r.reason ?? '',
  nsfw: r.nsfwEstimate ?? '?',
  sexual: !!r.sexualContent,
  minor: !!r.depictsMinor,
  photoreal: !!r.minorIsPhotorealistic,
  real: !!r.depictsRealPerson,
  buzz: r.hasBuzzReference !== false,
  video: r.type === 'video',
  prompt: (r.prompt ?? '').slice(0, 400),
}));

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Buzz Beggars Board — classifier review</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0b0d10; color:#e6e8eb;
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { position:sticky; top:0; z-index:10; background:#12151a; border-bottom:1px solid #23272e;
           padding:12px 16px; }
  h1 { font-size:15px; margin:0 0 10px; font-weight:600; letter-spacing:.01em; }
  h1 small { color:#8b939e; font-weight:400; margin-left:8px; }
  .bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  button.f, select, input[type=search] {
    background:#1a1e25; color:#e6e8eb; border:1px solid #2c313a; border-radius:7px;
    padding:6px 11px; font:inherit; font-size:13px; cursor:pointer; }
  button.f.on { background:#3b82f6; border-color:#3b82f6; color:#fff; }
  button.f .n { opacity:.65; margin-left:6px; font-variant-numeric:tabular-nums; }
  input[type=search] { min-width:210px; cursor:text; }
  label.chk { display:flex; align-items:center; gap:5px; color:#aeb6c0; font-size:13px;
              cursor:pointer; user-select:none; }
  .spacer { flex:1 1 auto; }
  .tally { color:#8b939e; font-size:13px; font-variant-numeric:tabular-nums; }
  main { display:grid; gap:12px; padding:16px;
         grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); }
  .card { background:#12151a; border:1px solid #23272e; border-radius:10px; overflow:hidden;
          display:flex; flex-direction:column; }
  .card.mark-ok { border-color:#22c55e; }
  .card.mark-no { border-color:#ef4444; }
  .thumb { position:relative; display:block; aspect-ratio:1; background:#080a0c; }
  .thumb img { width:100%; height:100%; object-fit:cover; display:block; }
  .badge { position:absolute; top:8px; left:8px; padding:3px 8px; border-radius:999px;
           font-size:11px; font-weight:700; letter-spacing:.03em; }
  .APPROVE { background:#12331f; color:#4ade80; box-shadow:inset 0 0 0 1px #1d5233; }
  .REJECT  { background:#3a1417; color:#f87171; box-shadow:inset 0 0 0 1px #5c1f24; }
  .ESCALATE{ background:#3a2a10; color:#fbbf24; box-shadow:inset 0 0 0 1px #5c431a; }
  .ERROR   { background:#26292f; color:#9aa3af; box-shadow:inset 0 0 0 1px #363b44; }
  .vid { position:absolute; top:8px; right:8px; background:#000a; padding:2px 7px;
         border-radius:999px; font-size:11px; }
  .body { padding:9px 10px; display:flex; flex-direction:column; gap:7px; flex:1; }
  .why { color:#c3cad3; font-size:12.5px; }
  .tags { display:flex; flex-wrap:wrap; gap:4px; }
  .tag { font-size:10.5px; padding:2px 6px; border-radius:5px; background:#20252d; color:#9aa3af; }
  .tag.bad { background:#3a1417; color:#f87171; }
  .tag.warn{ background:#3a2a10; color:#fbbf24; }
  .meta { display:flex; gap:8px; align-items:center; color:#6d7580; font-size:11px;
          margin-top:auto; padding-top:2px; }
  .meta a { color:#6d7580; text-decoration:none; }
  .meta a:hover { color:#3b82f6; }
  .marks { display:flex; gap:4px; margin-left:auto; }
  .marks button { background:#1a1e25; border:1px solid #2c313a; color:#8b939e; border-radius:5px;
                  padding:2px 7px; cursor:pointer; font-size:11px; line-height:1.5;
                  white-space:nowrap; }
  .marks button:hover { color:#e6e8eb; border-color:#3f4650; }
  .marks button.on[data-m=approve] { background:#22c55e; border-color:#22c55e; color:#04120a; font-weight:600; }
  .marks button.on[data-m=reject] { background:#ef4444; border-color:#ef4444; color:#fff; font-weight:600; }
  .empty { padding:60px 16px; text-align:center; color:#6d7580; }
</style></head><body>
<header>
  <h1>Buzz Beggars Board — classifier review
    <small>${rows.length} items · collection 3870938 · model ${rows[0]?.model ?? 'n/a'}</small></h1>
  <div class="bar">
    <span id="decisionFilters"></span>
    <select id="vFilter"><option value="">any violation</option>${allViolations
      .map((v) => `<option>${v}</option>`)
      .join('')}</select>
    <select id="nsfwFilter"><option value="">any rating</option><option>PG</option><option>PG-13</option><option>R+</option></select>
    <select id="markFilter">
      <option value="">all items</option>
      <option value="marked">marked by me</option>
      <option value="unmarked">not yet marked</option>
      <option value="disagree">disagreements only</option>
      <option value="agree">agreements only</option>
    </select>
    <label class="chk"><input type="checkbox" id="sexualOnly"> sexual flag only</label>
    <label class="chk"><input type="checkbox" id="minorOnly"> minor flag only</label>
    <input type="search" id="q" placeholder="search reason / prompt / id">
    <span class="spacer"></span>
    <span class="tally" id="tally"></span>
    <button class="f" id="export">download my marks</button>
    <button class="f" id="clear">clear marks</button>
  </div>
</header>
<main id="grid"></main>
<div class="empty" id="empty" hidden>nothing matches those filters</div>
<script>
const DATA = ${JSON.stringify(payload)};
const marks = JSON.parse(localStorage.getItem('bb-marks') || '{}');
// Marks were originally stored as right/wrong against the classifier. They now record what the
// reviewer would do, which reads the same on the card no matter what the classifier decided.
for (const [id, v] of Object.entries(marks)) {
  if (v === 'ok') marks[id] = 'approve';
  else if (v === 'no') marks[id] = 'reject';
}
localStorage.setItem('bb-marks', JSON.stringify(marks));
const agrees = r => marks[r.id] && marks[r.id].toUpperCase() === r.d;
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const state = { d:'', v:'', nsfw:'', sexual:false, minor:false, q:'', mark:'' };

const order = ['APPROVE','REJECT','ESCALATE','ERROR'];
const counts = ${JSON.stringify(counts)};
document.getElementById('decisionFilters').innerHTML =
  ['<button class="f on" data-d="">all<span class="n">' + DATA.length + '</span></button>']
  .concat(order.filter(d => counts[d]).map(d =>
    '<button class="f" data-d="' + d + '">' + d.toLowerCase() +
    '<span class="n">' + counts[d] + '</span></button>')).join('');

function matches(r) {
  if (state.d && r.d !== state.d) return false;
  if (state.v && !r.v.includes(state.v)) return false;
  if (state.nsfw && r.nsfw !== state.nsfw) return false;
  if (state.sexual && !r.sexual) return false;
  if (state.minor && !r.minor) return false;
  if (state.mark === 'marked' && !marks[r.id]) return false;
  if (state.mark === 'unmarked' && marks[r.id]) return false;
  if (state.mark === 'disagree' && (!marks[r.id] || agrees(r))) return false;
  if (state.mark === 'agree' && !agrees(r)) return false;
  if (state.q) {
    const hay = (r.reason + ' ' + r.prompt + ' ' + r.id).toLowerCase();
    if (!hay.includes(state.q.toLowerCase())) return false;
  }
  return true;
}

function card(r) {
  const tags = [];
  r.v.forEach(v => tags.push('<span class="tag bad">' + esc(v) + '</span>'));
  if (r.nsfw !== '?') tags.push('<span class="tag">' + r.nsfw + '</span>');
  if (r.minor) tags.push('<span class="tag warn">minor' + (r.photoreal ? ' · photoreal' : ' · stylized') + '</span>');
  if (r.real) tags.push('<span class="tag warn">real person</span>');
  if (!r.buzz) tags.push('<span class="tag">no buzz ref</span>');
  const m = marks[r.id];
  // Green border = you agreed with the classifier, red = you'd have called it the other way.
  const cls = m ? (agrees(r) ? 'mark-ok' : 'mark-no') : '';
  return '<div class="card ' + cls + '" data-id="' + r.id + '">' +
    '<a class="thumb" href="' + r.full + '" target="_blank" rel="noopener">' +
      '<img loading="lazy" src="' + r.src + '" alt="">' +
      '<span class="badge ' + r.d + '">' + r.d + '</span>' +
      (r.video ? '<span class="vid">video</span>' : '') +
    '</a>' +
    '<div class="body">' +
      '<div class="why">' + esc(r.reason) + '</div>' +
      '<div class="tags">' + tags.join('') + '</div>' +
      '<div class="meta"><a href="' + r.full + '" target="_blank" rel="noopener">#' + r.id + '</a>' +
        '<span class="marks">' +
          '<button data-m="approve" class="' + (m === 'approve' ? 'on' : '') + '">I\\'d approve</button>' +
          '<button data-m="reject" class="' + (m === 'reject' ? 'on' : '') + '">I\\'d reject</button>' +
        '</span></div>' +
    '</div></div>';
}

function render() {
  const shown = DATA.filter(matches);
  document.getElementById('grid').innerHTML = shown.map(card).join('');
  document.getElementById('empty').hidden = shown.length > 0;
  const marked = DATA.filter(r => marks[r.id]);
  const wrong = marked.filter(r => !agrees(r));
  const fr = wrong.filter(r => marks[r.id] === 'approve').length;
  const fa = wrong.filter(r => marks[r.id] === 'reject').length;
  document.getElementById('tally').textContent =
    shown.length + ' shown' +
    (marked.length
      ? ' · ' + marked.length + ' reviewed, ' + wrong.length + ' wrong (' +
        fr + ' should be approved / ' + fa + ' should be rejected)'
      : '');
}

document.getElementById('decisionFilters').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.d = b.dataset.d;
  document.querySelectorAll('#decisionFilters button').forEach(x => x.classList.toggle('on', x === b));
  render();
});
document.getElementById('vFilter').addEventListener('change', e => { state.v = e.target.value; render(); });
document.getElementById('nsfwFilter').addEventListener('change', e => { state.nsfw = e.target.value; render(); });
document.getElementById('sexualOnly').addEventListener('change', e => { state.sexual = e.target.checked; render(); });
document.getElementById('minorOnly').addEventListener('change', e => { state.minor = e.target.checked; render(); });
document.getElementById('q').addEventListener('input', e => { state.q = e.target.value; render(); });
document.getElementById('markFilter').addEventListener('change', e => { state.mark = e.target.value; render(); });

document.getElementById('grid').addEventListener('click', e => {
  const b = e.target.closest('.marks button'); if (!b) return;
  const id = b.closest('.card').dataset.id;
  marks[id] = marks[id] === b.dataset.m ? undefined : b.dataset.m;
  if (!marks[id]) delete marks[id];
  localStorage.setItem('bb-marks', JSON.stringify(marks));
  render();
});

document.getElementById('export').addEventListener('click', () => {
  const marked = DATA.filter(r => marks[r.id]).map(r => ({
    imageId: r.id,
    url: r.full,
    classifier: r.d,
    humanWouldHave: marks[r.id].toUpperCase(),
    agrees: agrees(r),
    classifierReason: r.reason,
    violations: r.v,
    signals: { nsfw: r.nsfw, sexual: r.sexual, minor: r.minor, buzzRef: r.buzz },
  }));
  const wrong = marked.filter(m => !m.agrees);
  const payload = {
    model: ${JSON.stringify(rows[0]?.model ?? 'unknown')},
    totalItems: DATA.length,
    reviewed: marked.length,
    disagreements: wrong.length,
    falseRejects: wrong.filter(m => m.humanWouldHave === 'APPROVE').length,
    falseApproves: wrong.filter(m => m.humanWouldHave === 'REJECT').length,
    marks: marked,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'buzz-beggars-marks.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('clear').addEventListener('click', () => {
  if (!confirm('Clear all ' + Object.keys(marks).length + ' marks?')) return;
  Object.keys(marks).forEach(k => delete marks[k]);
  localStorage.setItem('bb-marks', '{}');
  render();
});

render();
</script></body></html>`;

fs.writeFileSync(outFile, html);
console.log(`wrote ${rows.length} items -> ${outFile}`);
console.log('decisions:', counts);
