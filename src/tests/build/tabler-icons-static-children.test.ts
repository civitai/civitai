import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Pins `patches/@tabler__icons-react@3.34.1.patch`. Every tabler icon rebuilt its own shape
 * elements (`iconNode.map(createElement)`) on every render. Those elements depend only on the
 * icon's static `iconNode`, so the patch builds them once, on first render, and reuses them —
 * in production only. Development builds keep building them per render: a dev element records the
 * fiber that created it (`_owner`), so a cached one would pin the first icon's fiber. The patch
 * reads `process.env.NODE_ENV` at render time, so each test sets it (`vi.stubEnv`) rather than
 * relying on the test runner's own value (`test`).
 *
 * 🔴 If this file fails after a tabler upgrade, re-read `createReactComponent` in BOTH builds
 * (`dist/esm/createReactComponent.mjs` and the single-file `dist/cjs/tabler-icons-react.cjs`),
 * regenerate the patch or drop it, and update `package.json` → `pnpm.patchedDependencies`.
 */

const requireHere = createRequire(import.meta.url);
const pkgDir = path.dirname(requireHere.resolve('@tabler/icons-react/package.json'));

type Icons = Record<string, any>;
// Next rewrites `import { IconX } from '@tabler/icons-react'` to the per-icon ESM files
// (optimizePackageImports), which import `dist/esm/createReactComponent.mjs`; anything that
// `require`s the package gets the CommonJS bundle, which carries its own copy. Both are patched.
const builds: Array<[string, () => Promise<Icons>]> = [
  [
    'ESM (per-icon files)',
    async () => {
      const icons: Icons = {};
      for (const name of ['IconX', 'IconStar', 'IconHeartFilled']) {
        const file = pathToFileURL(path.join(pkgDir, `dist/esm/icons/${name}.mjs`)).href;
        icons[name] = (await import(/* @vite-ignore */ file)).default;
      }
      return icons;
    },
  ],
  ['CommonJS', async () => requireHere(path.join(pkgDir, 'dist/cjs/tabler-icons-react.cjs'))],
];

/** Calls the icon's forwardRef render function directly and returns the `<svg>` element. */
function renderSvg(Icon: any, props: Record<string, unknown> = {}): ReactElement<any> {
  return Icon.render(props, null);
}

// Markup produced by the UNPATCHED 3.34.1 build for each case — generated before the patch was
// written, so these are the bytes the patch must keep.
const SVG_OUTLINE_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const X_PATHS = '<path d="M18 6l-12 12"></path><path d="M6 6l12 12"></path>';
const EXPECTED: Array<[string, string, Record<string, unknown>, unknown, string]> = [
  [
    'plain',
    'IconX',
    {},
    undefined,
    `<svg ${SVG_OUTLINE_ATTRS} class="tabler-icon tabler-icon-x ">${X_PATHS}</svg>`,
  ],
  [
    'size/stroke/color/className/aria',
    'IconStar',
    { size: 18, stroke: 1.5, color: 'red', className: 'c1', 'aria-label': 'star' },
    undefined,
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="red" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="tabler-icon tabler-icon-star c1" aria-label="star"><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z"></path></svg>',
  ],
  [
    'title',
    'IconX',
    { title: 'Close' },
    undefined,
    `<svg ${SVG_OUTLINE_ATTRS} class="tabler-icon tabler-icon-x "><title>Close</title>${X_PATHS}</svg>`,
  ],
  [
    'extra children',
    'IconX',
    {},
    createElement('circle', { cx: 1, cy: 1, r: 1 }),
    `<svg ${SVG_OUTLINE_ATTRS} class="tabler-icon tabler-icon-x ">${X_PATHS}<circle cx="1" cy="1" r="1"></circle></svg>`,
  ],
  [
    'filled',
    'IconHeartFilled',
    { size: 12 },
    undefined,
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" class="tabler-icon tabler-icon-heart-filled "><path d="M6.979 3.074a6 6 0 0 1 4.988 1.425l.037 .033l.034 -.03a6 6 0 0 1 4.733 -1.44l.246 .036a6 6 0 0 1 3.364 10.008l-.18 .185l-.048 .041l-7.45 7.379a1 1 0 0 1 -1.313 .082l-.094 -.082l-7.493 -7.422a6 6 0 0 1 3.176 -10.215z"></path></svg>',
  ],
];

afterEach(() => {
  vi.unstubAllEnvs();
});

// children = [title?, ...shapes, ...extraChildren]
const shapes = (list: unknown[]) => list.slice(1, 3);

describe.each(builds)('tabler icons (%s build)', (_name, load) => {
  it('reuses the icon shape elements across renders in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const icons = await load();
    const first = renderSvg(icons.IconX).props.children as unknown[];
    const second = renderSvg(icons.IconX, { size: 30, title: 't' }).props.children as unknown[];
    expect(shapes(first)).toHaveLength(2);
    expect(shapes(second)[0]).toBe(shapes(first)[0]);
    expect(shapes(second)[1]).toBe(shapes(first)[1]);
    // Different icons never share shapes.
    const star = renderSvg(icons.IconStar).props.children as unknown[];
    expect(star[1]).not.toBe(shapes(first)[0]);
  });

  it.each(['development', 'test'])(
    'builds fresh shape elements on every render when NODE_ENV=%s',
    async (env) => {
      vi.stubEnv('NODE_ENV', env);
      const icons = await load();
      const first = renderSvg(icons.IconX).props.children as unknown[];
      const second = renderSvg(icons.IconX).props.children as unknown[];
      expect(shapes(first)).toHaveLength(2);
      expect(shapes(second)).toHaveLength(2);
      expect(shapes(second)[0]).not.toBe(shapes(first)[0]);
      expect(shapes(second)[1]).not.toBe(shapes(first)[1]);
      // Same shapes, though: only the element identity differs.
      expect(shapes(second)).toEqual(shapes(first));
    }
  );

  describe.each(['production', 'development'])('NODE_ENV=%s', (env) => {
    it.each(EXPECTED)(
      'server markup is unchanged: %s',
      async (_case, iconName, props, child, expected) => {
        vi.stubEnv('NODE_ENV', env);
        const icons = await load();
        const el = createElement(icons[iconName], props, child as any);
        // Twice: in production the first render builds the cached shapes, the second reuses them.
        expect(renderToStaticMarkup(el)).toBe(expected);
        expect(renderToStaticMarkup(el)).toBe(expected);
      }
    );
  });
});
