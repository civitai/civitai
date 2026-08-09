import path from 'path';
import { RuleTester } from 'eslint';
// The rule lives at the repo root (loaded in prod via eslint-plugin-local-rules).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const localRules = require(path.resolve(__dirname, '../../../../eslint-local-rules.js'));

const rule = localRules['no-unbounded-paging-fake'];

// Same RuleTester wiring as the sibling guards: `ruleTester.run(...)` must be called at
// the top level (nesting it inside `it()` throws "Calling the suite function inside test
// function is not allowed"), and `parser` is a valid ESLint 8 option that @types/eslint
// omits, so the config is built untyped and cast to keep `tsc --noEmit` green.
const ruleTesterConfig: Record<string, unknown> = {
  parser: require.resolve('@typescript-eslint/parser'),
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
};

const ruleTester = new RuleTester(ruleTesterConfig as never);

const errors = [{ messageId: 'unboundedPagingFake' }];

ruleTester.run('no-unbounded-paging-fake', rule, {
  valid: [
    // The shape this rule exists to require: a cap that returns a terminal cursor.
    `mockHScan.mockImplementation(async () => {
       pages += 1;
       if (pages > 50) return { cursor: '0', fields: [] };
       return { cursor: String(pages), fields: ['token-' + pages] };
     });`,
    // Terminal-only fake — one page and done.
    `mockHScan.mockImplementation(async () => ({ cursor: '0', fields: ['a'] }));`,
    // Other terminal spellings.
    `const f = async () => { if (done) return { cursor: 0 }; return { cursor: next }; };`,
    `const f = async () => { if (done) return { cursor: null }; return { cursor: next }; };`,
    `const f = async () => { if (done) return { cursor: '' }; return { cursor: n }; };`,
    // A ternary that can yield a terminal cursor DOES terminate — this is the shape of the
    // bounded hScan fake in packages/civitai-auth, which must not be flagged.
    `async function hScan(key, _cursor, options) {
       const page = all.slice(0, options?.COUNT ?? all.length);
       return { cursor: page.length < all.length ? 1 : 0, tuples: page };
     }`,
    // `nextCursor` is a real paginated-payload field here, not a paging fake, so it is not
    // in the default key set — a data fixture carrying one must stay clean.
    `const sample = () => ({ nextCursor: 9007199254740993n, items: [] });`,
    // Not a paging fake at all — no cursor key.
    `const f = async () => ({ fields: ['a'], total: 1 });`,
    // `cursor` on an object that is never returned is not a fake's page reply.
    `const state = { cursor: someValue }; doSomething(state);`,
    // Promise.resolve and await wrappers still see the terminal path.
    `const f = () => { if (done) return Promise.resolve({ cursor: '0' }); return Promise.resolve({ cursor: n }); };`,
    // A computed key is not the cursor property we mean.
    `const f = () => { return { [cursor]: n }; };`,
  ],
  invalid: [
    // The exact shape that shipped in #3756 and had to be fixed in #3757.
    {
      code: `mockHScan.mockImplementation(async () => {
               pages += 1;
               return { cursor: String(pages), fields: ['token-' + pages] };
             });`,
      errors,
    },
    // Implicit-return arrow, no terminal path.
    {
      code: `mockHScan.mockImplementation(async () => ({ cursor: String(pages), fields: [] }));`,
      errors,
    },
    // Shorthand property — we cannot see a terminal value, so it must be made explicit.
    {
      code: `const f = async () => { return { cursor, fields: [] }; };`,
      errors,
    },
    // `nextCursor` is the same trap under another name, but only when opted in.
    {
      code: `const f = async () => { return { nextCursor: String(page), items: [] }; };`,
      options: [{ extraKeys: ['nextCursor'] }],
      errors,
    },
    // A ternary whose branches are both non-terminal does NOT save it.
    {
      code: `const f = async () => { return { cursor: done ? next : other, fields: [] }; };`,
      errors,
    },
    // A terminal cursor returned by a NESTED function must not satisfy the outer one —
    // the outer fake is what the consumer loops on.
    {
      code: `const f = async () => {
               const inner = () => ({ cursor: '0' });
               return { cursor: String(pages), fields: [] };
             };`,
      errors,
    },
    // A non-empty template literal is not a terminal cursor.
    {
      code: 'const f = async () => { return { cursor: `${pages}`, fields: [] }; };',
      errors,
    },
  ],
});
