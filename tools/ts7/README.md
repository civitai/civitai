# tools/ts7

Holds the TypeScript 7 compiler used by `pnpm run typecheck:fast`. Nothing imports from here;
the only consumer is `scripts/typecheck-fast.mjs`, which resolves the binary through
`typescript/lib/getExePath.js`.

```bash
pnpm -C tools/ts7 install     # once — a root `pnpm install` does NOT fetch this
```

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

Bump the version in `package.json`, re-run the install here, and check three things rather than
one: `git diff pnpm-lock.yaml` at the repo root is still empty, the root `.bin/tsc` still reports
5.9.x, and `pnpm run typecheck:fast` still names the version you expect in its first line.
