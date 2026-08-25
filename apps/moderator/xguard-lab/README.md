# XGuard label lab

Infrastructure for developing XGuard labels: sample live prompts, have a model rate them, have a human confirm or overturn that rating, and end up with a labelled set the tuning harness can measure against.

The point is the loop, not any one label. Adding a label is adding an entry to `labels.ts` and running the rater again over samples you already have.

Scoping doc: `local/xguard-regex-retirement-scoping.md`. Tuning harness: `local/xguard-tuning-harness/`.

## Which database

`MODERATOR_DATABASE_URL` picks it. Deployed, that is the cluster's `internal_tools` instance and the lab runs online; locally, it is the docker container below, which exists so you can work without a tunnel. The schema is applied **by hand** in both — the `schema*.sql` files here are never auto-run (repo convention: no `prisma migrate deploy`).

## Running it

```bash
# 1. lab database — LOCAL ONLY (standalone, port 5433 so it can't collide with a local Civitai Postgres).
#    Skip this if MODERATOR_DATABASE_URL points at the cluster.
docker compose -f apps/moderator/xguard-lab/docker-compose.yml up -d

# 2. sample live prompts, stratified across a label's score bands
pnpm exec tsx --env-file=.env apps/moderator/xguard-lab/sample.ts \
  --batch 2026-08-04-age --size 250 --label Young

# 3. AI baseline rating for one label
pnpm exec tsx --env-file=.env apps/moderator/xguard-lab/rate.ts \
  --batch 2026-08-04-age --label AgeAsserted

# 4. review at /xguard
pnpm dev:moderator
```

The route needs a signed-in session and a `/xguard` grant, made on `/admin`, so the auth hub has to be
running too. Access is per-page in Postgres rather than a role tier, so until somebody makes that grant
only `moderator:admin` can open the lab.

## Driving it from an agent

Everything above except reviewing is also an HTTP endpoint under `/api/xguard/*`, each wrapped in
`WebhookEndpoint` (`$lib/server/webhook-endpoint`) and authenticated with the shared `WEBHOOK_TOKEN`,
sent as `?token=` or `Authorization: Bearer`. There is no user behind it: calls are not attributed to
anybody, and revoking access means rotating the token for everyone holding it.

`/xguard/docs` is the operator guide, and its endpoint list is generated from the routes rather than
written down. Read it there; a copy here would be the version that goes stale.

**Agents cannot write `human_judgement`.** The token authenticates `/api/*` endpoints that opt in, and reviewing is
a form action on a page route, so the ban holds without every future endpoint author having to remember
it. This matters more under a shared secret than it did under per-user keys: a row written through the
API could not even name who was behind it. If it ever needs relaxing, add a column recording that a row
came from the API and exclude those from ground truth by default — the point of the table is that a
person confirmed what a model proposed, and rows that break that rule must not be indistinguishable from
rows that don't.

## Why stratified sampling

`Young` scores >= 0.5 on 81% of all live traffic. A uniform sample would be almost entirely high-score rows and would say nothing about where the boundary sits. Equal-sized score bands put review time where the decision is actually in doubt.

## Why the rater comes first

Prompts run hundreds of tokens with the deciding term buried in style boilerplate, a non-English tail, or a LoRA filename. Asking a moderator to form a verdict from scratch is slow and error-prone - on the last tuning pass, 4 of 7 false positives I read by hand looked like moderator mistakes, including a prompt that literally says `teen-ager` verdicted as a false positive.

So the model reads carefully once and returns the exact spans it judged on. Those spans become the highlights, and the reviewer glances at three highlighted words instead of re-reading 800 tokens. `human_judgement` stores whether they **agreed**, plus the resulting verdict either way.

### Raters refuse

Safety-tuned models refuse some of this material outright and answer in prose instead of JSON. On the first 244-prompt run, `xiaomi/mimo-v2.5` refused 33 (14%).

A refusal is not a verdict. Recording it as `false` would quietly bias the training set on exactly the worst prompts, so `rate.ts` detects a non-JSON response, counts it, and retries on `--fallback-model` (`deepseek/deepseek-v4-flash` by default). Anything both models refuse stays unrated rather than being guessed at.

## Data model

The unit of work is a **(sample, label) pair**, not a sample. A prompt sampled today for age can be judged for sexual content next month without being re-sampled.

| table | holds |
|---|---|
| `sample` | prompt text, live XGuard scores at sample time, which batch |
| `label_def` / `label_policy` | the label set, and every revision of its policy prose |
| `machine_judgement` | what XGuard or the AI rater said, with reason and highlight spans |
| `human_judgement` | agree/disagree, resulting verdict, reviewer, time on item |
| `ground_truth` (view) | current verdict per pair, with reviewer count and whether contested |

Judgements reference an exact `label_policy` row, so editing a policy never silently rewrites past results. `duration_ms` is recorded because a reviewer averaging two seconds is rubber-stamping, and that only shows up if the number is honest.

The lab database has **no foreign keys into the Civitai database**. Moving it to its own cluster instance is a connection-string change.

## Scope

Age and sexual labels only. Celebrity/POI stays on the existing regex list - it's an intentional block on a name list, users aren't hitting it by accident, and a list is the right tool for that. Violence is deferred.

## Known gaps

- `orchestration.xguardPromptResults` has no `negativePrompt` column, so `sample.negative_prompt` is null for everything sampled from it. Asked Koen to add it; the schema and the rater already handle it.
- That table's `blocked` column is `false` on all 2.26M rows.
- Neither the model reasoning nor the generated image's maturity is persisted there yet.
