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
 * 🔴 CHOOSING THE ANCHOR TEXT — the real rot vector, and it is NOT line numbers.
 * Anchors are resolved to a line at run time, so an anchor survives the code moving,
 * and comment churn above it cannot SHIFT it. What DOES break it is the anchored TEXT
 * changing, and a miss is `die(2)` — which `--warn-only` deliberately does not
 * downgrade, so the first red is the production image build.
 *
 * 🔴 An earlier revision of this paragraph said "comment churn above it cannot break
 * it", full stop. That is FALSE and it misled a reader into treating a docblock edit in
 * a watchlisted module as free. `resolveAnchor` scans EVERY line, comments included, and
 * more than one match is also a hard error — so a COMMENT that merely CONTAINS the
 * anchor text breaks resolution just as a reword does. Rule 1 below makes this likelier,
 * not less: the shortest fragment is the easiest for prose to collide with. It is caught
 * by this gate's own unit suite rather than first at the image build
 * (`scripts/__tests__/assert-compiled-branches.test.ts` asserts every anchor resolves to
 * exactly one line), which is the only reason it is not a deploy-blocking trap. Two
 * rules follow:
 *
 *   1. Anchor a substring that survives REFORMATTING. Do not include a trailing `,`
 *      or `});`, and do not anchor a whole long line: a line near `printWidth` reflows
 *      the moment anyone adds a property (`cause`, a metrics counter), and prettier
 *      then splits it. Prefer the shortest unique fragment — stopping at an open
 *      paren is a good trick, since argument reflow keeps the callee on its own line.
 *   2. Prefer the branch's CONDITION over a payload inside it. A string literal can in
 *      principle be interned from elsewhere and keep a mapping while the branch around
 *      it is eliminated; a condition cannot. Where a condition is not unique in the
 *      module, a literal that is unique APP-WIDE is an acceptable substitute — see
 *      `block-token-subject-refusal` — because nothing else can intern it.
 *
 * Rewording an anchored message is therefore a watchlist edit too, not just a copy
 * change. That is the price of the gate, and it is cheap next to the defect it catches.
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
        why: "the fail-closed default. Lost, the function falls off the end and returns `undefined`, which a `?? 'full'` default upstream turns into a full-catalog grant.",
      },
    ],
  },
  {
    id: 'shared-storage-subject-refusal',
    module: 'src/server/routers/apps-shared.router.ts',
    why: "`resolveSharedContext` refuses a block token whose subject no longer hydrates, BEFORE consulting `app-blocks-shared-storage`. Lost, an unresolvable subject falls through to `{ user: undefined }` — a global eval, which returns the flag's BASE value, not a deny. Under a base-`enabled: true` GA flip every op in READ_OPS then serves shared rows to a token whose subject is gone. The write path is covered downstream by the min-trust gate; the read ops skip that block entirely and have no second belt, so this branch is the only thing in front of them.",
    control: [
      {
        code: 'isAppBlocksSharedStorageEnabled(',
        why: 'the flag call immediately after the refusal — same function, known to survive. Unmapped means this gate is looking at a build that never emitted `resolveSharedContext`, not at a violation. Deliberately stops at the open paren so reflowing the arguments cannot move it off this line.',
      },
    ],
    required: [
      {
        code: 'if (userId != null && !subjectUser) {',
        why: "the refusal's own CONDITION — the branch itself, not a payload inside it. Lost, the next line evaluates the flag with no subject and the answer becomes the flag base. The `userId != null &&` half is load-bearing in the other direction: without it a genuine anon token (`sub:'anon'`) would be refused too, which is the GA widening this gate must NOT block.",
      },
    ],
  },
  {
    id: 'block-token-subject-refusal',
    // MOVED 2026-09-18 out of `src/server/routers/blocks.router.ts`. The function is now
    // shared with the REST route `src/pages/api/v1/blocks/me.ts`, which cannot import a
    // tRPC router — so it lives in a service and BOTH doors call it. This field is a PIN:
    // the move made both anchors below resolve to zero lines in the old module until it
    // was updated here, which is the failure to expect if it is ever moved again.
    //
    // ⚠️ KNOWN LIMIT, WIDENED BY THAT MOVE. This gate unions mapped source lines across
    // EVERY emitted chunk, so it answers "did this branch survive SOMEWHERE", not "did it
    // survive in each consumer's chunk". The function now has two consumers — the tRPC
    // router and the `/api/v1/blocks/me` API route — so a build that kept the branch in
    // the router's chunk and dropped it from the API-route chunk would still pass. The
    // union is pre-existing (one module inlines into ~200 chunks, as this file's header
    // notes); recorded because the second consumer is new.
    module: 'src/server/services/blocks/block-token-access.service.ts',
    why: "`assertAppBlocksEnabledForTokenUser` refuses an unhydratable token subject BEFORE consulting `app-blocks-enabled`. Lost, it falls through to `isAppBlocksEnabled`'s no-user branch — a deliberate global eval kept for the machine registrar — which returns the flag's BASE value. Under a base-`enabled: true` GA flip a token whose subject no longer resolves then passes the kill-switch on every block-token runtime caller — the tRPC bridge procs AND the `/api/v1/blocks/me` REST route, which joined them when its hardcoded moderator literal was dropped. NB the sibling `assertViewerIsAppDeveloper` guard is deliberately NOT listed: `isAppBlocksAuthorEnabled` takes a non-nullable subject and dereferences it at once, so losing that one throws rather than passing.",
    control: [
      {
        code: 'await isAppBlocksEnabled({ user })',
        why: 'the flag call immediately after the refusal — same function, known to survive. Unmapped means the build never emitted this function.',
      },
    ],
    required: [
      {
        code: "'runtime block token subject could not be resolved'",
        why: "the refusal's message literal. Lost, the gate evaluates the kill-switch with no subject and a base-true flag answers `true`. NB this anchors a literal INSIDE the branch rather than the branch's condition. That was originally because `if (!user) {` was not unique in `blocks.router.ts`, where the function used to live alongside `assertViewerIsAppDeveloper`'s identical condition; since the 2026-09-18 move the condition IS unique in this module, so the literal is no longer the only option — it is kept because it remains the stronger anchor and re-pointing an anchor is itself a change worth not making idly. It is sound because the literal is unique ACROSS THE WHOLE APP: a minifier cannot intern it from another site, so a surviving mapping for this line means this site survived. Keep it unique — do not reuse this string elsewhere. 🔴 That uniqueness is why `/api/v1/blocks/me` renders this refusal with its OWN generic literal instead of echoing this message.",
      },
    ],
  },
  {
    id: 'post-subject-refusal',
    module: 'src/server/routers/blocks.router.ts',
    why: "`authorizeBlockPostRequest` refuses a post/preview whose token subject does not hydrate, BEFORE consulting `app-blocks-post-creation`. Lost, it falls back to the shape this branch replaced — the flag evaluated with no entity and no context, which returns the flag's BASE value rather than a deny. Under a base-`enabled: true` GA flip of post creation, a token whose subject no longer resolves would then be allowed to publish a PUBLIC, feed-visible post under that subject's byline. Same hazard as `shared-storage-subject-refusal` and `block-token-subject-refusal`, on the one surface where the consequence is public content rather than a read. NB the TypeScript cannot cover this: `BlockPostRequestAuth.subjectUser` is non-nullable, so deleting the branch in SOURCE is a type error — which is exactly why only an emitted-output gate can see a bundler dropping it.",
    control: [
      {
        code: 'isAppBlocksPostCreationEnabled({ user: subjectUser }',
        why: 'the flag call immediately after the refusal — same function, known to survive. Unmapped means the gate is looking at a build that never emitted this function, not at a violation. Stops before the closing paren so argument reflow cannot move it off this line.',
      },
    ],
    required: [
      {
        code: 'if (!subjectUser) {',
        why: "the refusal's own CONDITION rather than a payload inside it, per rule 2 of this file's header — a condition cannot be interned from another site. It is unique in this module today (the sibling `assertViewerIsAppDeveloper` refusal spells its binding `user`, not `subjectUser`); if a second `subjectUser` null-check is ever added to this router, re-point this anchor at the message literal instead, which is unique app-wide.",
      },
    ],
  },
];
