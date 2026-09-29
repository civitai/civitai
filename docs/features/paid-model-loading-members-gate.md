# Members-only loading for the coverage expansion

Only members may **start a download** by generating with a checkpoint that only the *expansion* covers.
Everything in the live coverage rule stays available to everyone, as does anything already resident, and
every other resource type is untouched.

Status: **live.** Released 2026-09-25 with `generation-coverage-next` already on and
`generation-loading-open-to-all` off, so the gate was active from the deploy rather than shipping dark.
Feature it extends: [paid-model-loading.md](paid-model-loading.md).

---

## The rule

| | non-member | member |
| --- | --- | --- |
| **Checkpoint** | `covered` OR (`coveredNext` AND already resident) | `coveredNext` |
| **everything else** | `coveredNext` | `coveredNext` |

**Moderators count as members**, whatever their tier — the same rule `isGatedFor.members` applies in
`gates.ts` ("mods + members keep access"). Leaving them out made a moderator unable to see the feature
they were asked to test, and put this gate out of step with the one beside it. A consequence worth
knowing: a moderator cannot observe the refusal as themselves, so testing the non-member path needs a
non-mod account.

They are refused only on an expansion checkpoint nobody has loaded yet — which is exactly the case
where saying yes means starting a download.

**`covered` is never gated.** For a checkpoint, `GenerationCoverage.covered` reduces to
`eco OR ext OR (common AND live_file AND ckpt AND auction)` — the `other_type` branch cannot be true
for a Checkpoint. So a covered checkpoint is an ecosystem checkpoint, an auction winner, or served
externally. An auction winner has **already been paid for**; gating it behind a membership would
charge twice for the same thing and take back what the auction sold.

**The non-checkpoint half of the expansion is not gated.** For a LoRA, embedding or VAE the
`covered` → `coveredNext` delta is only the file predicate: `next` accepts `Diffusers`, `live` does
not — and every non-checkpoint version the expansion adds is a Diffusers file
([the count and the query](paid-model-loading-coverage.md)). That is file-format support, not
download cost, so gating it would charge for a format fix.

⚠️ That last argument rests on today's data and nothing pins it. The first non-Diffusers
non-checkpoint to enter the expansion opens a download to non-members with no test failing.

---

## Where it lives

This is **not** a generation gate rule. Gate rules are for moderators to hide or kill-switch *named*
things — an unreleased ecosystem, a specific broken version. This is a policy over a derived set,
driven by a flag, with no authoring surface and nothing for a moderator to edit. An earlier draft did
build it on the rules model; that was reuse for its own sake, and it dragged in a moderator editor that
could silently delete the rule.

It rides on the coverage switch instead, which already had exactly the right shape — one decision, made
once per request, with a guard keeping it in one place per side.

| Concern | Where |
| --- | --- |
| Audience, resolved once per request | `coverageAudience` (`coverage-source.ts`) |
| The rule, over database columns | `coveredForUser` (`coverage-source.ts`) |
| The rule, as a SQL predicate | `coveredForUserSql` (`coverage-source.ts`) |
| The rule, over the indexed pair | `versionGeneratableFor` (`coverage-fields.ts`) |
| The rule, as a Meili page filter | `coverageFilter` (`coverage-fields.ts`) |
| Enforcement | none of its own — `canGenerate` goes false and the existing refusal fires |

A non-member submitting an expansion checkpoint that is cold gets the same refusal as any uncovered
resource.

**The explicit load path opts out.** `resolveLoadable` (`resource-load.service.ts`) calls
`getResourceLoadState` with `member: true` on purpose: that path *is* the purchase the gate exists to
ask for, so narrowing it there would refuse someone's money. A non-member can still **buy** a load.

⚠️ **The model feed is not gated yet.** `model.service.ts` derives each card's `canGenerate` from the
ungated column, so a non-member browsing `/models` still sees a Create button on a cold expansion
checkpoint and meets the refusal after composing a prompt. Gating it needs residency added to the
model-version Redis cache and that cache's key bumped — a hot-path change that wants its own
measurement, so it is deliberately not in this change.

`no-divergent-coverage-read` pins all of it: that each side derives the audience in one place, that no
other module pairs an expansion column with residency itself, and that only `coverage-source.ts` reads
either flag.

### Residency is read through `generatorReadiness`, never the column

`ModelVersion.generatorLoaded` is false forever for an `ExternalGeneration` version, so reading it raw
would gate every API checkpoint behind a download that never comes. `coveredForUser` calls
`isGeneratorReady`. `coveredForUserSql` cannot — a predicate sent to Postgres has no helper to call — so
it restates the rule in SQL and `no-divergent-generator-readiness` pins that both halves survive.

---

## The two flags

`generation-coverage-next` decides whether the expansion exists at all.
`generation-loading-open-to-all` decides who gets it.

| coverage-next | open-to-all | result |
| --- | --- | --- |
| off | — | nobody gets the expansion (today's behaviour) |
| on | off | members get the expansion; non-members get live + resident |
| on | on | everyone gets the expansion |

`generation-loading-open-to-all` is named for the **open** state on purpose: `isFlipt` answers false for
an unknown flag or an unreachable Flipt, so both the default and the failure land on the narrower
audience. A **percentage** rollout exempts that share of non-members, which is the ramp the old
`availableTo` enum could not express — it is evaluated with the user id as the entity, or Flipt hashes
the literal `'global'` and answers the same for everyone.

The members gate is meaningless while `generation-coverage-next` is off, so it ships behind that one.

---

## What a non-member sees

Nothing new. An expansion checkpoint that is cold is simply not generatable for them — the same state as
any uncovered model: no Create button on the model or version page, and filtered out of the generation
picker. The model **feed** is the exception, and still shows one; see the caveat under Where it lives.

**There is no upsell.** They are not told that a membership would unlock it. That is a deliberate
consequence of putting the rule in coverage rather than in the gate-rules system, which had a `message`
field. If an upsell is wanted it is an additive piece on top — a surface that notices
`coveredNext && !covered && !resident && !member` and says so — not a reason to move the rule back.

---

## Residency freshness

The gate's answer depends on whether a version is resident **right now**, so a stale read refuses
someone a model that has already loaded.

Three things keep it fresh, and they are not interchangeable:

- `ModelVersion.generatorLoaded` — written by `/api/webhooks/resource-availability` within seconds, and
  by `sync-generator-loaded-resources` every 15 minutes as the backstop.
- The models search index — both writers `queueUpdate` after their writes.
- `resourceDataCache` — the Redis row the **submit path** reads, on a one-hour TTL. Both writers bust it
  for the versions they flipped.

That third one is the one that bites: updating the column and the index leaves the submit reading an
hour-old snapshot, so the gate keeps refusing a resource that has loaded. The repo already stated this
rule for `paidAccess` (`generation.service.ts`): gating terms do not belong in that cache without a bust.

---

## Rollout

1. ~~Turn `generation-coverage-next` on.~~ Already on before this shipped, which is why the gate was
   live at the deploy rather than dark. Worth stating plainly: this feature never had an off state in
   production.
2. ~~Create `generation-loading-open-to-all` in Flipt, **off**.~~ Done at release. Off is also what an
   absent flag means, so the step bought the ability to ramp, not the gate.
3. **Where we are.** Watch download volume and queue depth. Ramp `generation-loading-open-to-all` by
   percentage to open it to non-members; set it on for everyone, or off to close it again, without a
   deploy.

**The baseline, measured the day before release.** Over the previous 7 days, across the 4,000
most-generated versions (17.2M generations), 304,666 used a checkpoint only the expansion covers — and
**zero** used one that was not already resident. Every expansion checkpoint people actually generate
with is loaded, so the gate cost existing users nothing at launch; it bites only on being first to pull
in something cold. That is the number to re-run before deciding the ramp has to move: if refusals are
still near zero, the gate is not doing anything a ramp would undo.

`generation-coverage-next` is global — it is evaluated with no entity, so it moves whole environments
at once. Only `generation-loading-open-to-all` is per-user, which is what makes step 3 a ramp rather
than a second switch. Signed-out visitors all evaluate as entity `'0'`, so for them a percentage is
all-or-nothing rather than a share.

---

## When this goes away

**The intent is that it does.** The gate exists to keep download volume controllable while on-demand
loading proves itself, not to make the expansion a membership perk permanently. Once step 3 has
`generation-loading-open-to-all` on for everyone and the numbers have held, the flag and everything
keyed to it should be deleted — `coverageAudience`'s second read, the `member` argument threaded
through `coveredForUser` / `versionGeneratableFor` / `coveredForUserSql` / `coverageFilter`, the
`member` field on the picker payload, and the audience half of `no-divergent-coverage-read`. What
remains is `pickCovered` and `versionCanGenerate`, which then retire with the coverage flag at its own
cutover.

That is also why the **model feed is not gated** (see above): gating it needs residency in the
model-version Redis cache and that cache's key bumped, on the busiest surface on the site. Worth
paying for a permanent rule; not worth paying for one we plan to delete. If the gate is still on
months from now, that trade flips and the feed should be done properly.

*Closes when:* the flag is on for everyone, the listed code is removed, and this section goes with it.

## Open

**The upsell.** Whether a non-member should be told a membership unlocks the model, and in what words.
Deliberately out of scope above; it is additive — and moot if the gate retires first.

*Closes when:* a decision is recorded here — either copy plus the surface that shows it, or a ruling
that no upsell ships — and @justin signs off on the wording if one does.
