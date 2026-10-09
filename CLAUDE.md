# Civitai Development Guide

Loaded into every session and every subagent and re-read every turn, so every line costs every task.
Add here only a rule that applies to nearly every task, as one instruction line. Everything else goes
where it loads on demand:
- applies to some files only → a `.claude/rules/*.md` with `paths:` frontmatter
- setup and how-to → `docs/dev/`; feature behaviour → `docs/features/`; a procedure → a skill
- why a rule exists, incident history → the commit message or PR body
- a personal preference (whether you use worktrees, review habits, voice) → your `CLAUDE.local.md` or
  `~/.claude/CLAUDE.md`, never a committed file

`no-claude-md-bloat` caps this file at 150 lines; move content out rather than raising the cap.

## How to work with us
- Plans are markdown documents in `docs/`. Our inline comments are marked `@dev:`; leave yours as `@ai:`.
- **Never open an issue or ticket without a closing condition** — what ends it and who or what checks it.
  Read `docs/dev/filing-follow-ups.md` before filing anything.
- Read a file before editing it; plan the change, then make one complete edit. Act after reading 3–5
  files rather than exploring indefinitely.
- When corrected, re-read the request and confirm before continuing. After 2 consecutive tool failures,
  change approach; when stuck, summarise what you tried and ask.

## The repo
- pnpm workspace. `src/` is the civitai.com Next.js 16 app (TypeScript, Mantine v7, Tailwind + SCSS
  modules, tRPC, Prisma/PostgreSQL, Zustand, React Query, Meilisearch).
- `apps/` — sibling apps (`auth`, `creator-studio`, `event-engine`, `moderator`, `notifications`,
  `orchestrator-gateway`, `storage`, `training-studio`), each with its own `CLAUDE.md` and
  `pnpm dev:<name>` / `pnpm release:<name>`. New app: the `scaffold-civitai-app` skill and
  `docs/packages/new-app-integration.md`. `apps/moderator`, `apps/auth` and
  `apps/creator-studio` are SvelteKit 5 + Kysely + shadcn-svelte: none of the main-app conventions apply;
  see `docs/svelte-app-standard.md`.
- `packages/civitai-*` — shared workspace packages. `event-engine-common/` is a git submodule.
- Auth is `@civitai/auth` (hub-driven `civ-token`); NextAuth is fully removed —
  `src/providers/SessionProvider.tsx` and `src/types/session.ts` replace `next-auth/react`.

## Where knowledge lives
- **`.claude/rules/`** — load automatically when you read or edit matching files: `testing`,
  `convention-guards`, `server` (architecture map, jobs), `database`, `sveltekit`, `components`,
  `comments`, `debug-endpoints`, `public-api`. Creating a new file loads nothing, so read the matching
  rule first; read one directly whenever you need it before touching code.
- **`docs/dev/`** — `local-setup.md` (env setup and the traps that cost hours: auth hub, SSL, env
  precedence, feature flags), `worktrees.md`, `prettier.md`, `filing-follow-ups.md`,
  `convention-guards.md` (every guard and what it enforces).
- **`docs/features/`** — check before implementing a feature (index: `docs/features/README.md`).
- **Skills** — `dev-server` (dev servers **and** worktrees), `postgres-query`, `civitai-review`, etc.

## Commands
- **Dev servers: always the `dev-server` skill**, never `pnpm run dev` directly. `start --app moderator|creator-studio`
  runs those from the current worktree with the auth hub; other `apps/*` use their own `pnpm dev:<name>`.
- **Local env misbehaving** (override ignored, sign-in fails, onboarding wizard everywhere)? Read
  `docs/dev/local-setup.md` first.
- **Worktrees are optional.** If you use one, create it with
  `node .claude/skills/dev-server/cli.mjs wt new <name> <branch>` and remove it with `wt stale` / `wt rm`,
  not the `EnterWorktree` tool or a hand-rolled `git worktree add`.
- `pnpm run typecheck` (authoritative; `typecheck:fast` is edit-loop only), `pnpm run lint`.
  In SvelteKit apps use `typecheck`, never `check` or a manual `svelte-kit sync`
  (details: `.claude/rules/sveltekit.md`).
- **Formatting:** `pnpm run prettier:write` formats uncommitted files only. Never run a repo-wide
  `prettier --write`, and never `prettier --plugin=prettier-plugin-svelte` (it empties `.svelte` files).
- **Releases** (`pnpm run release[:minor|:major]`) need explicit user approval — they bump, tag and push.

## Tests
More in `.claude/rules/testing.md` (loads when you touch a test file),
`.claude/rules/convention-guards.md` and `docs/dev/convention-guards.md`.

```bash
pnpm run test:unit:run     # unit suite over src/ + scripts/
pnpm run test:packages:run # packages/*      pnpm run test:apps:run   # apps/*
pnpm run test:component    # browser mode    pnpm run test:lint-rules # convention guards
pnpm test                  # Playwright e2e (pnpm run test:ui for the UI)
```
- The suites cover disjoint directories; `test:unit:run` runs nothing under `packages/` or `apps/`.
- Select the unit suite as **`--project 'unit*'`** — `--project unit` silently skips the `unit-native`
  files and exits 0.
- Run the suites covering your change while iterating (find them with
  `grep -rln '<symbol>' src --include=*.test.ts`), then the full suite once before committing.
  `vitest related` does **not** narrow this codebase.
- Run `pnpm run test:lint-rules` (~1s) whenever you touch a transaction, a mock, or a module-scope
  constant — those convention guards are tests, not eslint rules.
- Never put unit tests under `src/pages` — `next build` treats them as routes and fails.

## Database
Commands, generation and migration details: `.claude/rules/database.md`.

- **`packages/civitai-db-schema/prisma/schema.full.prisma` is the only schema you edit**; then
  `pnpm run db:generate`. Every other `schema.prisma` is generated or introspected.
- **Migrations are applied by hand. Never suggest `prisma migrate deploy`, `migrate resolve` or any
  auto-apply path.** Write the SQL under `packages/civitai-db-schema/prisma/migrations/`, commit it, and
  tell the user it needs applying manually (preview / staging / prod).
- Adding an enum value: deploy the regenerated client **before** the migration and any backfill.

## Security — this repository is public
Everything committed is permanently world-readable, including `docs/`, `claudedocs/`, `.claude/` and
history. Write all of it for strangers. Never commit secrets; keep `.env.example` placeholder-only;
sanitise user input with sanitize-html.

**Never commit these — they belong in the private infra repo:**
1. Unfixed vulnerabilities — no review, audit or handoff listing an open finding, least of all with `file:line`.
2. Content-safety internals — classifier policy text, thresholds, term lists, false-positive rates,
   blind spots. Architecture is fine; decision rules are an evasion guide.
3. Paths to production — bastions, SSH forwards, kubectl contexts, namespaces, deployment names,
   connection recipes. Write "ask an infra owner" instead.
4. Private-repo contents — names and internal paths of the infra/GitOps/orchestrator/flag-state repos.
5. Auth posture of internal services — never which header or secret is the only control.
6. People and customers — staff tied to systems, internal ticket IDs, private DMs, any named user's
   earnings, moderation status or content classification.
7. Bulk production data — real user IDs, emails or attributes, including in one-off backfill scripts.
8. Secret inventories annotated with what each secret unlocks.

Before committing a doc, ask: *if a stranger read only this file, what could they do that they couldn't
before?* If the answer is anything but "understand the product or contribute code", it goes private.
Documenting why a guard exists is one sentence from naming the bypass. Removal is not remediation —
anything committed counts as disclosed and must be fixed and rotated.

## Before committing
1. `pnpm run prettier:write`
2. Lint what you changed: `pnpm exec eslint <changed .ts/.tsx files>`. Skip the full `pnpm run typecheck`
   and `pnpm run lint` locally — PR CI runs both on every PR to `main`. (Typecheck can't be scoped to files.)
3. The unit suite (`pnpm run test:unit:run`); `pnpm run db:check-generated` if you touched the schema
4. Test the change locally
5. Before merging, check the PR's CI — `main` has no required checks, so a red run doesn't block.
6. Run `comment-review` over the diff and `docs-drift-review` over the commits — the two lanes with no
   automated gate. Required when you moved a file, renamed a script or command, retired an env var, or
   completed a tracked item.

**Every change to `main` goes through a PR** — never push to `main` directly. The one exception is the
version-bump commit a release script (`release[:minor|:major]`, `release:<app>`) pushes, run only with
explicit user approval.

**Never stack PRs.** Base every PR on the integration branch (`main` or a `feat/...` branch), never on
another open PR's branch — a squash-merged parent doesn't retarget the child, and its changes go missing.
If a change depends on an unmerged PR, wait for it to merge or fold both into one PR.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
