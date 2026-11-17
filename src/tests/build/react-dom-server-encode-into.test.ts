import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as ReactNS from 'react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

/**
 * Pins `patches/react-dom@18.3.1.patch`. Pages Router SSR streams through react-dom's
 * `server.browser` production build. Unpatched, it runs `TextEncoder.encode` once per dynamic
 * string (every text node, attribute value and style value) and then copies the result into a
 * 512-byte view. The patch writes string chunks straight into that view with
 * `TextEncoder.encodeInto`, the way the 18.3.1 Node build's `writeStringChunk` does, with one
 * difference: when a multi-byte character does not fit, it flushes only the bytes written, where
 * the Node build flushes the whole view (stale bytes included).
 *
 * The bytes on the wire must not change. The oracle is `renderToString` from the legacy build,
 * which builds one JS string and never goes through the patched code. For the trees below its
 * UTF-8 encoding was checked equal to the UNPATCHED stream output before the patch was written.
 *
 * 🔴 If a test here fails after a react-dom or Next.js upgrade, the patch no longer applies to the
 * code it was written for: re-read `writeChunk`/`stringToChunk` in the new build, regenerate the
 * patch or drop it, and update `package.json` → `pnpm.patchedDependencies`.
 */

const requireFromRepo = createRequire(join(process.cwd(), 'package.json'));
const reactDomDir = dirname(requireFromRepo.resolve('react-dom/package.json'));
const SERVER_FILE = realpathSync(
  join(reactDomDir, 'cjs/react-dom-server.browser.production.min.js')
);
const LEGACY_FILE = join(reactDomDir, 'cjs/react-dom-server-legacy.browser.production.min.js');

type StreamServer = {
  renderToReadableStream: (el: ReactElement) => Promise<ReadableStream<Uint8Array>>;
};
// The production file is loaded by path: under vitest NODE_ENV is 'test', so `react-dom/server`
// would hand back the development build, which the patch does not touch and Next does not run.
const server = requireFromRepo(SERVER_FILE) as StreamServer;
const legacy = requireFromRepo(LEGACY_FILE) as { renderToString: (el: ReactElement) => string };
const React = requireFromRepo('react') as typeof ReactNS;
const h = React.createElement;

async function streamBytes(el: ReactElement) {
  const reader = (await server.renderToReadableStream(el)).getReader();
  const parts: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(parts);
}

function firstDifference(a: Buffer, b: Buffer) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i === a.length && i === b.length ? -1 : i;
}

// 1-, 2-, 3- and 4-byte UTF-8 (a surrogate pair in JS) characters.
const WIDE = ['a', 'é', '中', '😀'];

/**
 * Every shape the patched writer branches on: ASCII; multi-byte characters landing on the
 * 512-byte view boundary at every offset (the run of spans whose text length steps by one);
 * strings either side of the `3 * length > 512` cutoff (170/171 code units) that routes a string
 * to a standalone encode; strings whose UTF-8 is larger than the view; and precomputed chunks
 * (tag names, attribute names, `="`) interleaved with all of them.
 *
 * The cutoff sweep puts 171-256 three-byte characters (513-768 bytes) behind ~450 bytes of ASCII.
 * Only there does a cutoff looser than `3 * length` show: such a string would be encodeInto'd into
 * a nearly full view, and its remainder would no longer fit in a fresh one.
 */
function variedTree() {
  const cutoffSweep = [];
  for (let n = 171; n <= 256; n++) {
    for (let k = 0; k < 3; k++) cutoffSweep.push(h('s', { key: `p${n}-${k}` }, 'x'.repeat(150)));
    cutoffSweep.push(h('q', { key: `q${n}` }, '中'.repeat(n)));
  }
  const sweep = [];
  for (let i = 0; i < 700; i++) {
    sweep.push(h('span', { key: i, 'data-i': i }, WIDE[i % 4].repeat(1 + (i % 61)), i));
  }
  return h(
    'div',
    { id: 'root', title: 'Ünïcødé — ✓ 日本語 😀' },
    h('p', null, 'plain ascii'),
    h('p', null, 'multi-byte: é ü — 中文 한국어 😀🎉'),
    ...[169, 170, 171, 300, 510, 511, 512, 513, 2000].map((n) =>
      h('i', { key: `a${n}` }, 'x'.repeat(n))
    ),
    ...[100, 170, 171, 200, 400, 512].map((n) => h('b', { key: `c${n}` }, '中'.repeat(n))),
    ...[60, 84, 86, 170, 172, 200].map((n) =>
      h('u', { key: `e${n}` }, '😀'.repeat(n / 2) + 'é'.repeat(n / 2))
    ),
    h('pre', null, '中'.repeat(5000)),
    h('article', null, cutoffSweep),
    h('section', null, sweep),
    h('img', { src: '/a.png', alt: 'alt "q" & <x> 😀' }),
    h('input', { defaultValue: 'v'.repeat(171) }),
    h('div', { style: { marginTop: 4, color: 'red', '--x': '日本' } }, 'styled')
  );
}

describe('patched react-dom server.browser production build', () => {
  it('streams the same bytes as renderToString for ASCII, multi-byte and boundary-straddling text', async () => {
    const expected = Buffer.from(legacy.renderToString(variedTree()), 'utf8');
    const got = await streamBytes(variedTree());

    expect(expected.length).toBeGreaterThan(150_000); // the tree spans many 512-byte views
    expect(firstDifference(got, expected)).toBe(-1);
  });

  it('does not run TextEncoder.encode per short string, so the patch is live', async () => {
    const encode = TextEncoder.prototype.encode;
    const encodedTexts: string[] = [];
    TextEncoder.prototype.encode = function (input?: string) {
      if (input !== undefined && /^t\d+$/.test(input)) encodedTexts.push(input);
      return encode.call(this, input);
    };
    let bytes: Buffer;
    try {
      const items = Array.from({ length: 1000 }, (_, i) => h('i', { key: i }, `t${i}`));
      bytes = await streamBytes(h('div', null, items));
    } finally {
      TextEncoder.prototype.encode = encode;
    }
    // Positive control: the 1,000 texts did reach the output.
    expect(bytes.toString('utf8')).toContain('<i>t999</i>');
    // Unpatched, every one of them goes through encode (1,000).
    expect(encodedTexts).toHaveLength(0);
  });
});

describe('Next.js Pages SSR loads the patched file', () => {
  // A child process, because loading a Next server runtime installs process-wide hooks.
  it.each(['pages-turbo.runtime.prod.js', 'pages.runtime.prod.js'])('%s', (runtime) => {
    const script = `
      const r = require('node:module').createRequire(process.cwd() + '/package.json');
      r('next/dist/compiled/next-server/${runtime}');
      const loaded = Object.keys(require.cache).filter((k) => k.includes('react-dom-server'));
      console.log('PROBE_RESULT ' + JSON.stringify(loaded));
    `;
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 50_000,
    });
    const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
    if (run.status !== 0 || !line) {
      throw new Error(`probe failed (exit ${run.status}):\n${run.stderr}\n${run.stdout}`);
    }
    const loaded = (JSON.parse(line.slice('PROBE_RESULT '.length)) as string[]).map((f) =>
      realpathSync(f)
    );
    expect(loaded).toContain(SERVER_FILE);
  });
});
