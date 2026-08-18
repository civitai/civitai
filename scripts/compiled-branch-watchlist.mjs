/**
 * Security-relevant branches that must survive into the COMPILED server output.
 *
 * WHY THIS EXISTS
 * ---------------
 * A bundler can emit a function whose body is not the body you wrote. On the build that
 * shipped release 5.1.18, `resolveStoreVisibilityScopeUninstrumented` in
 * `src/server/services/app-blocks-flag.ts` was emitted as
 *
 *     async function S(e){if(await p(e))return"full"}
 *
 * — two of its three `return`s were gone, so it fell off the end and produced `undefined`
 * for every non-privileged caller. One missing value, two `??` defaults pointing opposite
 * ways: the REST listing service defaulted it to `'full'` and served the whole catalog to
 * anonymous callers, while the tRPC procedures defaulted it to `'none'` and showed the
 * cohort an empty store.
 *
 * Nothing else we run can see this. The TypeScript is correct, so `tsc` is green; ESLint
 * reads source; Vitest imports the source module, not the emitted chunk. A 75-test unit
 * suite, an integration suite driving the real feature-flag client, and four rounds of
 * review were all STRUCTURALLY incapable of catching it — every one of them exercises the
 * TypeScript. Only the emitted artefact knows, and it does not complain.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * Two consumers need this list: `assert-compiled-branches.mjs`, which enforces it against
 * a real build, and `__tests__/assert-compiled-branches.test.ts`, which drives the gate
 * over synthetic builds. Mirrors `server-graph-watchlist.mjs` for the same reason: one
 * list, one place, so a new entry is proven satisfiable by the suite rather than breaking
 * its positive control.
 *
 * HOW AN ENTRY IS CHECKED
 * -----------------------
 * Not by grepping the emitted JS. Minified names differ per chunk, the same module is
 * inlined into ~200 of them, and a returned literal is indistinguishable from the same
 * string in an array — `["full","public-external","none"]` occurs ~481 times in this
 * build and none of them is a return. Instead the gate reads the emitted `.js.map`
 * `sources`/`mappings`: an anchor's SOURCE LINE either has a mapping somewhere in the
 * server output or it does not. That is decoy-free, survives renaming, and survives the
 * minifier collapsing `if (a) return x; return y;` into a ternary — the collapsed token
 * still maps back to both source lines.
 *
 * WRITING AN ENTRY
 * ----------------
 *  module   Repo-relative source path.
 *  required Anchors that MUST be represented in the output. Each `code` is an exact,
 *           unique substring of a line in that file — the gate resolves it to a line
 *           number at run time, so the entry cannot rot when the file moves around.
 *  control  Anchors in the SAME function that must ALSO be mapped. These are the
 *           positive control: if the control is unmapped the gate reports that it could
 *           not observe the function at all (exit 2) instead of claiming a violation.
 *           Without one, a module that simply was not emitted reads as N violations.
 *
 * Keep this list SMALL and justified — a fail-closed branch whose loss changes who can
 * see what. Every entry must say what goes wrong when the branch disappears.
 */
export const COMPILED_BRANCH_WATCHLIST = [
  {
    id: 'store-visibility-scope',
    module: 'src/server/services/app-blocks-flag.ts',
    why: 'The App-store read-path scope resolver. Losing the axis-2 grant or the fail-closed default makes the function return `undefined`, which the read paths then default in OPPOSITE directions — the whole catalog to anonymous callers on one side, an empty store on the other. This is the exact shape that shipped in release 5.1.18 (civitai#3983).',
    control: [
      {
        code: "if (await isAppListingsEnabled(opts)) return 'full';",
        why: 'axis 1 — the branch that DID survive; if this is unmapped the gate is looking at a build that never emitted this function',
      },
    ],
    required: [
      {
        code: "if (await isExternalListingsPublicEnabled(opts)) return 'public-external';",
        why: 'axis 2 — the external-only grant. Lost, the cohort resolves no scope at all.',
      },
      {
        code: "return 'none';",
        why: 'the fail-closed default. Lost, the function falls off the end and returns `undefined`, which a `?? \'full\'` default upstream turns into a full-catalog grant.',
      },
    ],
  },
];
