---
name: civitai-plan-review
description: Plan-first review for Civitai work (civitai/civitai, apps/*, the orchestrator, Creator Studio, HQ-facing features), run BEFORE building, not after. Every Civitai plan gets two sections written by the author, "Existing systems" (what in the codebase, past PRs, tasks and services already does part of this, with file:line and the searches run) and "How it ships" (one finished change in one PR unless a named release constraint forces phases). Larger or riskier plans then get fresh Opus critics, reuse first, until every lane gives a thumbs up, then one ask to your user. Use when you write a plan, design doc or build brief for a Civitai feature, migration, backfill, generator/orchestrator change, payment or moderation flow, or a new app or service.
---

# Civitai plan review: find what exists, then build

Most reuse and scope checking happens after the code exists, in `civitai-review` and the hosted
`pr-review`, where a "no" means a rewrite. This skill asks those questions of the plan, where a "no"
costs a paragraph. The after-the-fact reviews still run; this adds a step in front of them.

## Hub seats and everyone else

Some steps name tools that exist only on the agent hub (`who_worked_on`, `store_find`, `hq_task`,
cards). Each has a fallback, so the skill works from any Claude Code session:

| Step | On a hub seat | Otherwise |
|---|---|---|
| Ask your user (a decision, the tier-2 sign-off) | One card to your user (`ask_templates` first) | Ask your user however your setup does |
| Past seats' work on this concept | `who_worked_on query:"<concept>"` | Ask your user who has worked on it |
| Standing rules | `store_find collection:ruling` (project civitai) | Ask your user for any standing rules |
| Tasks, including closed and wontfix | `hq_task list` or the `hq` CLI | The `hq` CLI if you have it; else your team's tracker |
| File a follow-up or a removal task | `hq_task` / `task` | Your team's tracker, with a closing condition (`docs/dev/filing-follow-ups.md`) |

"Ask your user" below always means this row.

## Tiers

| Tier | When | What runs | Rough cost |
|---|---|---|---|
| **0: Existing systems + How it ships** | Every Civitai plan or build brief, no exceptions | Author writes both sections below. No critics. | ~10 min of the author |
| **1: Reuse check** | The plan adds a new service, table, tRPC router, component family, app, cron/job, cache, endpoint or skill | Tier 0 + lane R (reuse) | ~$3 |
| **2: Full** | Any trigger in the list below | Tier 0 + lanes R, 1, 2, 3, 4, and 5 when anything turns on | ~$20-35 |

Tier 2 triggers:
- migration, schema change, or backfill over prod rows
- money, Buzz, payouts, payments, membership
- auth, sessions, permissions, API keys, tokens
- moderation, content safety, NSFW or minors gating, scanning
- the generation or orchestrator pipeline (generators, workflows, providers, coverage)
- a feature flag or anything on by default for users
- a new app under `apps/`, or a new service that other teams will call
- a user-facing flow on the feed path or the home page
- your user or a lead asked for a review

Not sure between tiers? Run the higher one. A one-file bug fix with a known cause needs only tier 0,
and its two sections can be three lines.

## Tier 0, part 1: "Existing systems" (author, always)

Put this section in the plan, ABOVE the design. Write it before you design anything.

For each moving part of the plan (each new function, table, page, job, endpoint, flag, script):

| Part | What already does some of it (file:line, task, PR, service) | Search that found it | Extend or new, and why |
|---|---|---|---|
| e.g. "list a user's images" | `getMyImages` in `src/server/services/image.service.ts` | grep of the export list | Extend: add a filter |

Where to look, in this order (record each search you ran, including the ones that found nothing):
1. **Feature docs**: `docs/features/README.md` and the feature doc for this area.
2. **Architecture map**: `.claude/rules/server.md`, `.claude/rules/components.md`, `.claude/rules/database.md`.
3. **The reuse map**: the "Where the existing thing usually lives" section of
   `.claude/agents/civitai-reuse-review.md` (big services, selectors, schema, caches, tRPC ladder,
   server utils, components, hooks, constants). Read the whole export list of any service you would
   add to: `grep -nE "^export (async function|function|const) " src/server/services/<x>.service.ts`.
4. **Search by shape, not by name**: the table, the column, the URL shape, the Mantine component. The
   duplicate is never named like the new code.
5. **Packages and sibling apps**: `packages/civitai-*`, `apps/*` (Svelte apps have their own
   conventions, `docs/svelte-app-standard.md`).
6. **History**: was it built, tried or rejected before?
   - `gh pr list -R civitai/civitai --state all --search "<concept>" --limit 20`
   - `git log --oneline -S "<symbol>" -- <path>` for removed code
   - tasks for the concept, including closed and wontfix ones (table above)
   - earlier seats' work and standing rules (table above)
7. **Other services**: the orchestrator's issues if you can read them, existing skills in
   `.claude/skills/` and `~/.claude/skills/`, the moderator app.
8. **Data that already exists**: is the number or field you plan to compute already stored, cached
   or in ClickHouse? Read replica / ClickHouse only, with a `# why:` line.

A part with "new" in the last column needs a reason that names the existing thing and why it does
not fit (wrong shape, wrong owner, deprecated, too slow, measured). "Didn't find anything" is only
acceptable with the searches listed next to it.

## Tier 0, part 2: "How it ships" (author, always)

Every plan says how the change ships. **The default is one finished change in one PR.** Phases,
feature-flag stages and back-compat shims are allowed only for a named release constraint:
- old clients in the wild that still call the old shape;
- migration ordering: a migration or a regenerated client that has to land before the code;
- an app on its own release schedule (a mobile app, a sibling app under `apps/`).

"Safer" in general is not a constraint. When the plan does use a phase, flag stage or shim, it:
1. names the release constraint that forces it;
2. lists every piece of temporary code with the condition that removes it, and files that removal as
   a task with a closing condition (table above);
3. does not split the work into small PRs just to make each one easier to review.

## Tier 0, also

Before any critic reads the plan:
- Every number the plan relies on was measured, with count, window and a positive control.
- Your user's and teammates' words are quoted verbatim with where they said it, not paraphrased.
- The plan lives at a path critics can read: `<INTENT_DIR>/plans/<feature>.md` (the absolute path,
  even from a worktree; see `.claude/agents/civitai-intent-review.md` for `INTENT_DIR`), or a page.
- Nothing private goes into a public file. Plans stay out of the repo; see the root CLAUDE.md
  security list.

## Lanes (tiers 1 and 2)

Each lane is one fresh critic: Agent tool, `subagent_type: general-purpose`, `model: opus`,
`run_in_background: true`. Brief = `briefs/_common.md` with one lane file filled in.

| # | Lane | Brief | Runs in |
|---|---|---|---|
| R | Reuse and existing systems | `briefs/R-reuse.md` | tiers 1 and 2, always first |
| 1 | Simplest, verified, and How it ships | `briefs/1-simple.md` | tier 2 |
| 2 | Intent (the requester's words) | `briefs/2-intent.md` | tier 2 |
| 3 | Scale and cost on Civitai's data | `briefs/3-scale.md` | tier 2 |
| 4 | Safety: money, access, minors, privacy, disclosure | `briefs/4-safety.md` | tier 2 |
| 5 | Rollout, brake and rollback | `briefs/5-rollout.md` | tier 2, whenever anything turns on or a migration/backfill runs |

Lane R gets the plan's "Existing systems" table and attacks it: it re-runs the searches, adds its own
same-shape searches, and checks the history sources. Its findings are the ones most likely to change
the design, so in tier 2 fold lane R's round-1 findings into the plan before the other lanes' round 2.

## Scope guards

Plan reviews can add scope nobody asked for. These rules hold that line:
- **A must-fix has to be about this plan's job.** "While you're in there, also…" is not a blocker; the
  author may decline it with a reason and lose nothing.
- **The intent lane flags additions**, including ones that came from earlier review rounds.
- **Follow-ups a critic spots go in a separate task** (table above), not into this plan or its PR.

## Rounds and the stop rule

- **Round 1:** all lanes in parallel, one message. At most 5 must-fixes each.
- **Round 2+:** resume the SAME critics with SendMessage: the new version, a "changed because of you"
  table, and your disagreements with reasons. At most 3 blockers each. A blocker would make the build
  fail, duplicate something that exists, or mislead your user; not a preference.
- **Final round:** "Are your blockers fixed? Under 100 words, with a VERDICT line."
- **Stop** when every lane's last line is `VERDICT: thumbs up`. Thumbs up with nits passes.
- **A redesign** gets fresh critics. **Still thumbs down after round 4:** stop, and put the split to
  your user as a decision.
- Critics give the verdict inside SendMessage; read it there. Each writes its report file too.

## What reaches your user, and where it shows up later

- **Tier 0 and 1:** no ask for the review itself. The plan or build brief says
  `existing-systems: <plan path or page>` (tier 0) or `plan-review: R thumbs up on vN` (tier 1).
- **Tier 2:** one ask (on a hub seat, the `proposal` template fits) linking the plan, with each lane's
  verdict and rounds, the "Existing systems" table (short), the How-it-ships section, the
  changed-because-of-them table, disagreements, which numbers were rerun, and the review's measured
  cost (critic transcripts under `~/.claude/projects/<proj>/<session>/subagents/*.jsonl`, deduped by
  `message.id`).
- **Merge packages** for risky PRs name the plan and its review line.

## Traps

- Each critic keeps scripts in its own `<lane>-scripts/` folder; shared folders got overwritten.
- Fill in `review-for:` with the plan's task id.
- Most round-2 blockers were the author's own stale wording. Grep for retired terms after every edit.
- Repeated idle notifications repeat a report; don't answer them.
- The reuse map in `civitai-reuse-review.md` is the best single list of where things hide. If lane R
  finds a home for something that map doesn't name, say so in the ask so the map gets updated.
