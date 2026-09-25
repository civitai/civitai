# tools/ts7

Holds the TypeScript 7 compiler used by `pnpm run typecheck:fast`. Nothing imports from here;
the only consumer is `scripts/typecheck-fast.mjs`, which resolves the binary through
`typescript/lib/getExePath.js`.

```bash
pnpm -C tools/ts7 install     # once — a root `pnpm install` does NOT fetch this
```

## What it is for

A second compiler for the edit loop. Measured 2026-09-21 on this repo, with the spread on both
sides because the box is shared: `pnpm run typecheck:fast` 29-98s cold and 6-56s warm over 8 runs;
`pnpm run typecheck` 192-539s over 4. An order of magnitude, not a ratio.

`pnpm run typecheck` stays authoritative — it is what CI, `lint` and `svelte-check` run. The two
compilers disagree in both directions (TS 7.0.2 reports `(a ?? null) ?? b` as TS2871 "always
nullish" while typing that same operand `string | null` in assignment position), so a diagnostic
from the fast lane is a lead, not a fact.

It takes **no arguments**: it always checks the whole project, so that "0 diagnostics" cannot mean
"the compiler was asked to check nothing". Narrow a check with `pnpm run typecheck` instead.

⚠️ It is **not** routed through the dev-server queue that `pnpm run typecheck` uses, so N agents
running it at once are N unserialised native compilers. The 56s end of that warm range is the
busy-box figure — size the risk from that end, not the 6s one.

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
committed on purpose and is why `pnpm -C tools/ts7 install` is reproducible.

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

Bump the version in `tools/ts7/package.json`, re-run `pnpm -C tools/ts7 install`, then check three
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
