import path from 'path';
import { RuleTester } from 'eslint';
// The rule lives at the repo root (loaded in prod via eslint-plugin-local-rules).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const localRules = require(path.resolve(__dirname, '../../../../eslint-local-rules.js'));

const rule = localRules['no-ssr-divergent-media-query'];

// Same harness shape as no-module-scope-cache.test.ts: RuleTester drives the test
// framework's globals, so `ruleTester.run(...)` must be called at the TOP LEVEL of the
// module (NOT nested inside a vitest `it()`). `parser` is a valid top-level RuleTester
// option in ESLint 8 (eslintrc mode) but @types/eslint's config type omits it — build
// untyped and cast so `tsc --noEmit` stays green.
const ruleTesterConfig: Record<string, unknown> = {
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
};
const ruleTester = new RuleTester(ruleTesterConfig as ConstructorParameters<typeof RuleTester>[0]);

/**
 * `no-ssr-divergent-media-query` — the hooks with no server answer.
 *
 * 🔴 THIS REPLACES A 250-LINE HAND-ROLLED SOURCE SCANNER, and the history is the reason
 * the rule is shaped as a rule rather than as another file-reading test. That scanner
 * lived in `src/components/Apps/__tests__/appsRailGeometry.test.ts`, applied to exactly
 * ONE file, and was found bypassable in five consecutive audit rounds — an unanchored
 * regex, brace-counting on raw text, an unterminated-apostrophe mask runaway, a `/*`
 * route-glob runaway, and a deps-array depth bug. Every red in its entire history was a
 * planted mutant; it never caught a real violation. An ESLint rule applies repo-wide,
 * parses with the real TypeScript parser, and is the house convention (38 sibling
 * `no-*.test.ts` files run by `pnpm test:lint-rules`).
 *
 * 🔴 `useContainerSmallerThan` IS IN THE BANNED SET DELIBERATELY. It is what
 * `CollectionsLayout` — the in-repo rail precedent that `AppsPageLayout`'s own docstring
 * cites by name — uses for its rail/drawer swap (`useContainerSmallerThan('sm')`), and it
 * wraps `useContainerQuery`, returning FALSE while `inlineSize === 0`, which is exactly
 * what the server always sees. Banning the other three without it would be an allowlist.
 */
ruleTester.run('no-ssr-divergent-media-query', rule, {
  valid: [
    // The point of the ban: the breakpoint is a CSS question, so nothing reads it in JS.
    `export function Layout() {
       return <div className={classes.railRow} />;
     }`,
    // An unrelated hook with the same prefix.
    `const v = useState(false);`,
    // A name that merely CONTAINS a banned one is not a banned call.
    `const v = useMediaQueryBuilder();`,
    // 🔴 THE CARVE-OUT THIS RULE MUST NOT BREAK. Reading the breakpoint inside an EFFECT
    // is legitimate: an effect runs after paint, so it cannot decide what was rendered.
    // The rail's drawer-close effect is exactly this shape, and a rule that red it would
    // have been reverted rather than obeyed.
    `useEffect(() => {
       const mql = window.matchMedia('(min-width: 1300px)');
       if (mql.matches) close();
     }, [close]);`,
    // The raw API is deliberately NOT this rule's business — see the rule's docstring.
    `const wide = typeof window !== 'undefined' && window.matchMedia('(x)').matches;`,
    // An import alone is not a render-time read.
    `import { useMediaQuery } from '@mantine/hooks';`,
  ],
  invalid: [
    // ── each banned name, in the shape it actually appears in this repo ──
    {
      code: `const isWide = useMediaQuery('(min-width: 1300px)');`,
      errors: [
        {
          messageId: 'ssrDivergentMediaQuery',
          data: { name: 'useMediaQuery', spelled: 'useMediaQuery' },
        },
      ],
    },
    {
      code: `const isMobile = useIsMobile();`,
      errors: [
        {
          messageId: 'ssrDivergentMediaQuery',
          data: { name: 'useIsMobile', spelled: 'useIsMobile' },
        },
      ],
    },
    {
      code: `const small = useContainerQuery({ smallerThan: 'md' });`,
      errors: [
        {
          messageId: 'ssrDivergentMediaQuery',
          data: { name: 'useContainerQuery', spelled: 'useContainerQuery' },
        },
      ],
    },
    {
      // The one the precedent uses. Reduced from CollectionsLayout.tsx:88.
      code: `const isMobile = useContainerSmallerThan('sm');`,
      errors: [
        {
          messageId: 'ssrDivergentMediaQuery',
          data: { name: 'useContainerSmallerThan', spelled: 'useContainerSmallerThan' },
        },
      ],
    },
    // ── an ALIASED import is resolved back through the import ──
    {
      code: `import { useMediaQuery as useMQ } from '@mantine/hooks';
             const isWide = useMQ('(min-width: 1300px)');`,
      errors: [
        { messageId: 'ssrDivergentMediaQuery', data: { name: 'useMediaQuery', spelled: 'useMQ' } },
      ],
    },
    // ── a member call ──
    {
      code: `const isMobile = hooks.useIsMobile();`,
      errors: [
        {
          messageId: 'ssrDivergentMediaQuery',
          data: { name: 'useIsMobile', spelled: 'useIsMobile' },
        },
      ],
    },
    // ── inside JSX, i.e. deciding a render outright ──
    {
      code: `export function Body() {
               return useContainerSmallerThan('sm') ? <Drawer /> : <Rail />;
             }`,
      errors: [
        {
          messageId: 'ssrDivergentMediaQuery',
          data: { name: 'useContainerSmallerThan', spelled: 'useContainerSmallerThan' },
        },
      ],
    },
    // ── the `extraHooks` option widens the set without a code change ──
    {
      code: `const v = useViewportSize();`,
      options: [{ extraHooks: ['useViewportSize'] }],
      errors: [
        {
          messageId: 'ssrDivergentMediaQuery',
          data: { name: 'useViewportSize', spelled: 'useViewportSize' },
        },
      ],
    },
  ],
});
