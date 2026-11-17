import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Pins `patches/react@18.3.1.patch`. React 18's production `jsx()` copies every prop of the
 * config object into a fresh props object for every element. The patch does what React 19 does —
 * when the config has no `key`, `ref`, `__self` or `__source` and the type has no `defaultProps`,
 * the config object itself becomes `props` — but only on the server (`typeof window ===
 * 'undefined'`). Compiled JSX always passes a fresh object literal, so nothing else holds it.
 *
 * 🔴 If this file fails after a React upgrade, the patch no longer applies to the code it was
 * written for: re-read `jsx()` in the new build, regenerate the patch or drop it (React 19 ships
 * the behaviour natively), and update `package.json` → `pnpm.patchedDependencies`.
 */

const requireFromRepo = createRequire(join(process.cwd(), 'package.json'));
// Loaded by path: under vitest NODE_ENV is 'test', so `react/jsx-runtime` would hand back the
// development build, which the patch does not touch and production does not run.
const RUNTIME_FILE = realpathSync(
  join(
    dirname(requireFromRepo.resolve('react/package.json')),
    'cjs/react-jsx-runtime.production.min.js'
  )
);

type Element = { type: unknown; key: string | null; ref: unknown; props: Record<string, unknown> };
type Runtime = {
  jsx: (type: unknown, config: Record<string, unknown>, key?: string) => Element;
  jsxs: (type: unknown, config: Record<string, unknown>, key?: string) => Element;
};

const server = requireFromRepo(RUNTIME_FILE) as Runtime;

/** The same production file evaluated with a `window` in scope — i.e. what a browser runs. */
function loadAsBrowser(): Runtime {
  const mod = { exports: {} as Runtime };
  new Function('require', 'module', 'exports', 'window', readFileSync(RUNTIME_FILE, 'utf8'))(
    requireFromRepo,
    mod,
    mod.exports,
    {}
  );
  return mod.exports;
}

describe('patched react jsx-runtime production build (server)', () => {
  it('uses the config object as props when there is no key, ref or defaultProps', () => {
    const config = { className: 'a', children: 'x' };
    expect(server.jsx('div', config).props).toBe(config);
    const many = { children: ['a', 'b'] };
    expect(server.jsxs('ul', many).props).toBe(many);
  });

  it('a key passed as the third argument still reuses props, and lands on the element', () => {
    const config = { title: 't' };
    const el = server.jsx('li', config, 'k1');
    expect(el.props).toBe(config);
    expect(el.key).toBe('k1');
  });

  it('copies, and strips key from props, when the config carries a key', () => {
    const config = { key: 'k', id: 'i' };
    const el = server.jsx('div', config);
    expect(el.props).not.toBe(config);
    expect(el.key).toBe('k');
    expect(el.props).toEqual({ id: 'i' });
    // An explicit undefined key is still not a prop.
    const undefinedKey = { key: undefined, id: 'j' };
    expect(Object.keys(server.jsx('div', undefinedKey).props)).toEqual(['id']);
  });

  it('copies, and strips ref from props, when the config carries a ref', () => {
    const ref = { current: null };
    const config = { ref, id: 'i' };
    const el = server.jsx('div', config);
    expect(el.props).not.toBe(config);
    expect(el.ref).toBe(ref);
    expect(el.props).toEqual({ id: 'i' });
  });

  it('copies when the type has defaultProps, and never writes the defaults into the caller object', () => {
    function WithDefaults() {
      return null;
    }
    WithDefaults.defaultProps = { tone: 'muted', size: 1 };
    const config = { size: 2 };
    const el = server.jsx(WithDefaults, config);
    expect(el.props).not.toBe(config);
    expect(el.props).toEqual({ tone: 'muted', size: 2 });
    expect(config).toEqual({ size: 2 });
  });

  it('copies when the config carries __self or __source', () => {
    const config = { __self: {}, __source: {}, id: 'i' };
    const el = server.jsx('div', config);
    expect(el.props).not.toBe(config);
    expect(el.props).toEqual({ id: 'i' });
  });
});

describe('patched react jsx-runtime production build (browser)', () => {
  // Invariant guard, not regression coverage: the unpatched build copies everywhere, so this
  // passes before and after the patch. It pins the patch's scope — the browser keeps React 18's
  // copy semantics, so client reconciliation (which compares props by identity) is untouched.
  it('keeps the copy path when a window exists', () => {
    const browser = loadAsBrowser();
    const config = { className: 'a' };
    const el = browser.jsx('div', config);
    expect(el.props).not.toBe(config);
    expect(el.props).toEqual(config);
  });
});

/**
 * Server HTML must not change. A representative tree — Mantine components (which call `jsx` from
 * `react/jsx-runtime` internally), tabler icons, a react-query mutation hook, a keyed list, a
 * class component with defaultProps, a forwardRef with a ref, memo, Fragment, raw HTML and inline
 * styles — is rendered twice in production-mode child processes: once with the runtime as
 * installed (server branch: reuses props) and once with the same file evaluated with a `window`
 * in scope (React 18's copy semantics). The two HTML strings must be byte-identical.
 *
 * The reuse counter is the positive control: the comparison is only meaningful if the first run
 * actually took the reuse path for a large share of elements and the second never did.
 */
const PROBE = String.raw`
const mode = process.argv[1];
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const r = Module.createRequire(process.cwd() + '/package.json');
const runtimePath = fs.realpathSync(path.join(path.dirname(r.resolve('react/package.json')), 'cjs/react-jsx-runtime.production.min.js'));
const m = new Module(runtimePath);
m.filename = runtimePath;
m.paths = Module._nodeModulePaths(path.dirname(runtimePath));
new Function('require', 'module', 'exports', 'window', fs.readFileSync(runtimePath, 'utf8'))(
  (id) => m.require(id), m, m.exports, mode === 'copy' ? {} : undefined
);
m.loaded = true;
require.cache[runtimePath] = m;
let total = 0, reused = 0;
for (const name of ['jsx', 'jsxs']) {
  const orig = m.exports[name];
  m.exports[name] = (type, config, key) => {
    const el = orig(type, config, key);
    total++;
    if (el.props === config) reused++;
    return el;
  };
}
const { jsx, jsxs } = r('react/jsx-runtime');
const React = r('react');
const { renderToString } = r('react-dom/server');
const { MantineProvider, Button, Badge, Card, Text, Group, Stack, Anchor, Title } = r('@mantine/core');
const { IconHeart, IconStar, IconDownload } = r('@tabler/icons-react');
const { QueryClient, QueryClientProvider, useMutation } = r('@tanstack/react-query');
class Legacy extends React.Component {
  render() { return jsx('span', { 'data-tone': this.props.tone, children: this.props.label }); }
}
Legacy.defaultProps = { tone: 'muted' };
const Fwd = React.forwardRef((props, ref) => jsx('input', { ref, ...props }));
const Memo = React.memo((props) => jsxs('p', { className: props.c, children: ['memo ', props.n] }));
function Save() {
  const m = useMutation({ mutationFn: async () => 1 });
  return jsx(Button, { loading: m.isPending, disabled: m.isPending, children: 'Save ' + m.status });
}
const Wrap = (props) => jsx(Badge, { ...props });
const items = Array.from({ length: 25 }, (_, i) => ({ id: i, name: 'Model ' + i + ' <&> "q"', nsfw: i % 3 === 0 }));
const tree = jsx(QueryClientProvider, { client: new QueryClient(), children: jsx(MantineProvider, { children: jsxs(Stack, { gap: 'sm', children: [
  jsx(Title, { order: 2, children: 'Representative tree' }),
  jsxs(Group, { justify: 'space-between', children: [jsx(IconHeart, { size: 16 }), jsx(IconStar, { size: 18, stroke: 1.5, className: 'x' }), jsx(Save, {})] }),
  ...items.map((it) => jsx(Card, { withBorder: true, padding: 'xs', children: jsxs(Group, { children: [
    jsx(Text, { fw: 600, lineClamp: 1, children: it.name }),
    it.nsfw ? jsx(Wrap, { color: 'red', variant: 'light', children: 'NSFW' }) : null,
    jsx(Anchor, { href: '/models/' + it.id, children: jsx(IconDownload, { size: 14 }) }),
  ] }) }, it.id)),
  jsx(Legacy, { label: 'legacy' }),
  jsx(Legacy, { label: 'legacy2', tone: 'loud' }),
  jsx(Fwd, { defaultValue: 'v', 'aria-label': 'a', ref: React.createRef() }),
  jsx(Memo, { c: 'm', n: 3 }),
  jsx('div', { dangerouslySetInnerHTML: { __html: '<b>raw</b>' } }),
  jsxs(React.Fragment, { children: [jsx('i', { style: { marginTop: 4, color: 'red' }, children: 'styled' }), 'text'] }),
] }) }) });
const html = renderToString(tree);
console.log('PROBE_RESULT ' + JSON.stringify({ html, total, reused }));
`;

function probe(mode: 'reuse' | 'copy') {
  // A child process: NODE_ENV must be 'production' before React is first loaded.
  const run = spawnSync(process.execPath, ['-e', PROBE, mode], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 50_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = run.stdout.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
  if (run.status !== 0 || !line) {
    throw new Error(
      `probe failed (exit ${run.status}):\n${run.stderr}\n${run.stdout.slice(0, 2000)}`
    );
  }
  return JSON.parse(line.slice('PROBE_RESULT '.length)) as {
    html: string;
    total: number;
    reused: number;
  };
}

describe('server HTML is unchanged by props reuse', () => {
  it('renders a representative tree byte-identically with and without reuse', () => {
    const reuse = probe('reuse');
    const copy = probe('copy');

    // Positive controls: the tree is substantial, the patched run reused props for many
    // elements, and the copy run never did.
    expect(reuse.html.length).toBeGreaterThan(10_000);
    expect(reuse.html).toContain('data-tone="muted"'); // defaultProps applied
    expect(reuse.html).toContain('Save idle'); // the mutation hook rendered
    expect(reuse.total).toBe(copy.total);
    expect(reuse.reused).toBeGreaterThan(reuse.total / 4);
    expect(copy.reused).toBe(0);

    expect(reuse.html).toBe(copy.html);
  });
});
