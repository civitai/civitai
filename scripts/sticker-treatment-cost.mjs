/**
 * Per-frame cost of the candidate sticker treatments.
 *
 * Run from a worktree root: `node scripts/sticker-treatment-cost.mjs`
 * `CARDS=200 node scripts/sticker-treatment-cost.mjs` to change the element count.
 *
 * **Runs uncapped on purpose.** With vsync on, every treatment here fits inside
 * a 16.67ms interval, so the numbers come back as exact multiples of the vsync
 * period and the harness measures *dropped intervals* rather than cost —
 * anything between 0.1ms and 16.6ms reads identically, and re-running produces
 * whichever ranking the scheduler felt like.
 *
 * ## Read this before believing a table
 *
 * **Uncapped is not a property of this script. It is a property of this script
 * plus enough work to outrun the compositor.** Below roughly 50 elements the
 * flags stop taking effect and the readings fall back to multiples of 16.6ms —
 * at `CARDS=15` the ordering comes out *reversed*, with motion reading 40x
 * cheaper than doing nothing. If any column is near 17, 33 or 50, the run is
 * measuring vsync and the table means nothing. Do not quote it.
 *
 * **Only visible cards paint, but every animation ticks.** The grid is 5x300px
 * in a 900px viewport scrolled 720px, so about 20 cards are ever painted no
 * matter what `CARDS` says. So the filtered options (lift, dieCut, plate) are
 * flat in `CARDS` while motion grows linearly with it — 1.3ms at 50, 2.4 at
 * 200, 12.3 at 1000. The motion multiplier is therefore a function of the
 * number you picked, not a property of the treatment. Do not cite one.
 *
 * What survives every count: **plate is reproducibly ~3x the others and is the
 * only count-independent non-zero reading.** That is the finding.
 *
 * It is still synthetic: no React, no data fetching, no image decode, no
 * network, and headless desktop Chromium is not a mid-range phone. Read it as
 * the cost of the CSS alone, on hardware kinder than the median reader's.
 */
import { chromium } from 'playwright';

const CARDS = Number(process.env.CARDS ?? 50);
const FRAMES = Number(process.env.FRAMES ?? 240);

const TREATMENTS = {
  none: { image: '' },
  lift: {
    image: 'filter: drop-shadow(0 1px 1px rgba(0,0,0,.55)) drop-shadow(0 6px 10px rgba(0,0,0,.4));',
  },
  dieCut: {
    image:
      'filter: drop-shadow(1.5px 0 0 #fff) drop-shadow(-1.5px 0 0 #fff) drop-shadow(0 1.5px 0 #fff) drop-shadow(0 -1.5px 0 #fff) drop-shadow(0 3px 5px rgba(0,0,0,.45));',
  },
  plate: {
    image: '',
    behind:
      '-webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); background: rgba(0,0,0,.25);',
  },
  motion: { image: 'filter: drop-shadow(0 2px 4px rgba(0,0,0,.45));', animate: true },
};

// A star with real alpha, so drop-shadow has a silhouette to trace. Tracing a
// rectangle is much cheaper and would flatter every filtered option.
const STICKER =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><path d="M128 12 158 96 246 96 175 148 202 232 128 180 54 232 81 148 10 96 98 96Z" fill="#e8478b"/></svg>`
  ).toString('base64');

const page = (key) => {
  const t = TREATMENTS[key];
  const cards = Array.from(
    { length: CARDS },
    (_, i) => `
    <div class="card">
      <div class="art"></div>
      <div class="wrap" style="transform: translate(-50%,-50%) rotate(${(i % 7) - 3}deg)">
        ${t.behind ? `<span class="behind" style="${t.behind}"></span>` : ''}
        <div class="${t.animate ? 'anim' : ''}"><img src="${STICKER}" style="${t.image}"></div>
      </div>
    </div>`
  ).join('');

  return `<!doctype html><meta charset=utf-8><style>
  body{margin:0;background:#111}
  .grid{display:grid;grid-template-columns:repeat(5,300px);gap:12px}
  .card{position:relative;width:300px;height:400px;overflow:hidden;border-radius:8px}
  .art{position:absolute;inset:0;background:
    repeating-linear-gradient(45deg,#2b3a55 0 14px,#40587f 14px 28px)}
  .wrap{position:absolute;left:52%;top:46%;width:26%}
  .behind{position:absolute;inset:-9%;border-radius:22%;z-index:-1}
  img{width:100%;height:auto;display:block}
  @keyframes pop{0%{transform:scale(.72)}62%{transform:scale(1.06)}100%{transform:scale(1)}}
  @keyframes sway{0%,100%{transform:rotate(-1.6deg)}50%{transform:rotate(1.6deg)}}
  .anim{animation:pop .42s cubic-bezier(.34,1.56,.64,1) both,sway 6s ease-in-out .42s infinite;
        transform-origin:50% 85%;will-change:transform}
  </style><div class="grid">${cards}</div>`;
};

const run = async (browser, key) => {
  const p = await browser.newPage({ viewport: { width: 1560, height: 900 } });
  await p.setContent(page(key));
  await p.waitForTimeout(600);

  const stats = await p.evaluate(
    (frames) =>
      new Promise((resolve) => {
        const times = [];
        let last = performance.now();
        let n = 0;
        const tick = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          window.scrollBy(0, 3);
          if (++n < frames) requestAnimationFrame(tick);
          else {
            const sorted = times.slice(1).sort((a, b) => a - b);
            const at = (q) => sorted[Math.floor(sorted.length * q)];
            resolve({
              frames: sorted.length,
              p50: +at(0.5).toFixed(2),
              p95: +at(0.95).toFixed(2),
              max: +sorted[sorted.length - 1].toFixed(2),
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    FRAMES
  );

  await p.close();
  return stats;
};

const browser = await chromium.launch({
  args: ['--disable-frame-rate-limit', '--disable-gpu-vsync'],
});

const out = {};
for (const key of Object.keys(TREATMENTS)) {
  const runs = [await run(browser, key), await run(browser, key), await run(browser, key)];
  // Median of three: absolutes move ~40% run to run, the ordering does not.
  out[key] = runs.sort((a, b) => a.p50 - b.p50)[1];
}
await browser.close();

const capped = Object.values(out).some((r) => r.p50 > 8);
console.log(`${CARDS} elements, ${FRAMES} frames/run, median of 3 runs. ms/frame.`);
if (capped) {
  console.log('WARNING: readings look vsync-capped — a p50 above 8ms means multiples of 16.6.');
  console.log('The flags did not take effect at this element count. Raise CARDS to ~50 or more.');
  console.log('The table below counts dropped intervals, not cost. Do not quote it.');
}
console.table(out);
