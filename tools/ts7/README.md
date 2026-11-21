# tools/ts7

Holds the TypeScript 7 compiler used by `pnpm run typecheck` and `pnpm run typecheck:tests`.
Nothing imports from here; `scripts/lib/ts7.mjs` resolves the binary through
`typescript/lib/getExePath.js` and installs this directory from its own lockfile on first use, so
there is no manual step. To install it by hand:

```bash
pnpm -C tools/ts7 install --ignore-workspace --frozen-lockfile   # a root `pnpm install` does NOT fetch this
```

`--ignore-workspace` is required: without it pnpm finds the root `pnpm-workspace.yaml` above this
directory, installs the root workspace instead, and leaves this one empty.

## What it is for

The compiler of the repo's typecheck. `scripts/typecheck.mjs` runs it single-threaded on dev
machines (several agents typechecking at once must not exhaust memory) and with `--checkers 2` in
CI. The root `typescript` dependency stays 5.9 because ESLint, `next build`, `svelte-check` and
the codegen import its compiler API, which TS 7.0 does not ship. `TYPECHECK_COMPILER=5 pnpm run
typecheck` runs 5.9 instead, for a suspected TypeScript 7 disagreement.

Measured 2026-11-20 (32-core box, `origin/main`, 3 runs each): cold 5.9 134 s at 8.4 GB peak vs
TS7 single-threaded 48 s at 7.3 GB; the first edit to a router file after a build 5.9 ~194 s vs
~56 s. The two compilers can disagree (TS 7.0.2 reports `(a ?? null) ?? b` as TS2871 "always
nullish" while typing that same operand `string | null` in assignment position).

`pnpm run typecheck:tests` is a per-file ratchet whose baseline is measured by this same compiler.
The root `tsconfig.json` excludes every test file, so `typecheck:tests` is their only typecheck.

## Why this is not a pnpm workspace package

It was, briefly. Adding `tools/*` to `pnpm-workspace.yaml` made `pnpm install` re-resolve
**msw's optional `typescript` peer from 5.9.3 to 7.0.2 across twelve unrelated importers**:

```
-  msw@2.12.10(@types/node@24.13.3)(typescript@5.9.3)
+  msw@2.12.10(@types/node@24.13.3)(typescript@7.0.2)
```

`pnpm install` exited 0 and printed nothing about it. Workspace membership was sufficient on its
own — the bin isolation a subpackage buys was working correctly at the same time (root
`.bin/tsc` stayed 5.9.2).

Keeping it outside the workspace costs the one install command above and buys a root
`pnpm-lock.yaml` that does not move at all. Verified: with `tools/ts7` outside the workspace,
`git diff pnpm-lock.yaml` is empty and `grep -c 'typescript@7.0.2' pnpm-lock.yaml` is 0.

**`pnpm-lock.yaml` in this directory is TypeScript 7's pin, not a stray artifact.** It is
committed on purpose and is why `pnpm -C tools/ts7 install --ignore-workspace` is reproducible.

## The same hazard one layer down

Do **not** reach for an npm alias instead:

```jsonc
// DON'T
"typescript7": "npm:typescript@7.0.2"
```

Measured side by side with `typescript@5.9.2` in an isolated package, `pnpm install` exit 0:

```
node_modules/.bin/tsc --version   ->  Version 7.0.2
node_modules/typescript (direct)  ->  Version 5.9.2
lines in the install log          ->  0
```

An alias changes a package's **name**, not its **`bin` names**. Both declare `bin: { tsc }`, the
alias wins, and every `npx tsc` and `pnpm run tsc:trace` in the repo silently becomes TS7.

## Upgrading

Bump the version in `tools/ts7/package.json`, re-run `pnpm -C tools/ts7 install --ignore-workspace`, then check three
things rather than one. **All of these run from the repo root:**

```bash
git diff --stat pnpm-lock.yaml        # must be EMPTY: the root lockfile must not move
node_modules/.bin/tsc --version       # must still be 5.9.x: the root compiler is not this one
"$(cd tools/ts7 && node -e "import('./node_modules/typescript/lib/getExePath.js').then(m=>console.log(m.default()))")" --version
```

The third resolves the **native binary** and runs it. The version in
`tools/ts7/node_modules/typescript/package.json` is the shim's, and would not tell you about a
stale binary underneath it.

## A note on the measurements above

The msw peer re-resolution and the `.bin` hijack were measured on 2026-09-21 and describe states
this repo is deliberately no longer in, so neither is reproducible from the tree as it stands.
They are recorded as the reason for the shape, not as something to re-verify.
