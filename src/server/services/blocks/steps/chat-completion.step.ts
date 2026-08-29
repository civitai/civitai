import type { ChatCompletionInput } from '@civitai/client';
import * as z from 'zod';
import type { BlockStep, OrchestratorStepTemplate } from './index';

// ─────────────────────────────────────────────────────────────────────────────
// Tranche 2, entry 1 — `chatCompletion`. The first `'textOutput'` adopter.
//
// WHY THIS ONE QUALIFIES, against the same bars `convert-image` was checked on:
//
//  1. A GENUINE STANDALONE `$type`. `ChatCompletionStep` /
//     `ChatCompletionStepTemplate` with `$type: 'chatCompletion'` are first-class
//     in the generated `@civitai/client` types, and the orchestrator runs the
//     step standalone (Civitai's own `xGuardModeration` scanning is implemented
//     as `chatCompletion` jobs).
//
//  2. COST KNOWABLE BEFORE EXECUTION → `prepaidFixed`. 🔴 THIS BAR USED TO READ
//     "FLAT, MEASURED COST… charged **1 Buzz**, and that held across every model
//     below AND across `maxTokens` 1 → 200,000". THAT WAS FALSE — re-measured
//     2026-08-27, the price differs per model and rises with `maxTokens`. What
//     survives is the bar itself: the orchestrator can QUOTE the price before
//     execution (`whatif:true`), which is what `prepaidFixed` actually requires.
//     Flatness was never the requirement, and the entry qualifies without it.
//     See `CHAT_COMPLETION_PRICE_BUZZ`.
//
//  3. A FREE-TEXT OUTPUT, WITH A POSTURE THAT COVERS IT. This is the whole
//     reason the entry could not be written until `'textOutput'` existed. The
//     generated reply is scanned at the READ boundary by `./moderation`'s output
//     phase and withheld on a policy hit or on one of the specific failure modes
//     enumerated below — see WHAT ACTUALLY WITHHOLDS. It is NOT withheld on
//     "any scanner failure"; that phrasing was wrong and one real gap sits
//     inside it.
//
//  4. NO AIR RESOURCE. `ChatCompletionInput.model` is a plain provider id
//     ("gpt-4o"), NOT an AIR URN, so there is nothing for the entitlement belt
//     to gate → `resourcePolicy: { kind: 'none' }`, which clause 7's deep AIR
//     scan verifies against the step this entry actually BUILDS.
//
// 🔴 THE MODEL ALLOWLIST IS LOAD-BEARING, AND IT IS NOT IN `resourcePolicy`.
// `staticAllowlist` is AIR-only — its single field is `airs` and clause 7's
// enforcement is a `urn:air:` substring scan — so putting "deepseek/deepseek-chat"
// in it would be a lie that makes the eventual real AIR-allowlist implementation
// wrong for this entry. `'none'` is therefore TRUTHFUL here, and the model bound
// lives where the registry already provides one: the `z.enum` in this entry's own
// `.strict()` `paramSchema`, declared as the entry's `variants` and resolved
// through `resolveStepVariant`.
//
// 🔴 WHY THAT BOUND MATTERS RATHER THAN BEING TIDINESS: there is NO
// ORCHESTRATOR-SIDE MODEL VALIDATION. Measured against the live orchestrator — a
// fabricated model name is quoted 1 Buzz, **CHARGED** 1 Buzz, and then fails at
// execution with `workflow status: failed` and no output and no refund. Without
// the enum, an app typo burns a viewer's Buzz on a guaranteed failure.
//
// 🔴 KNOWN GAP, STATED RATHER THAN PAPERED OVER — THE INPUT IS NOT AUDITED.
// `messages` is free text from an untrusted iframe, and this entry runs NO
// prompt audit over it. That is not an oversight and it is not fixable in this
// file: `ACCEPTABLE_POSTURES_BY_TYPE` constrains `chatCompletion` to exactly
// `['textOutput']` and is deliberately A SET, NOT A LADDER (see `./index`), so
// declaring `'promptAudit'` is rejected at load; and clause 1a's REVERSE
// direction rejects an entry that declares `auditableText` under a posture that
// never audits it. The registry models ONE posture per entry, so an entry with
// free text on BOTH sides cannot express both today. What IS covered: everything
// this step publishes goes through the output scan. What is NOT: the input text
// never meets `auditPromptServer`, so it produces no `BlockedPromptEntry` and no
// violation counter. Closing it needs a registry-level decision about
// multi-surface postures, not a workaround here.
//
// 🔴 TOOL CALLING ENLARGED THAT GAP WITHOUT CHANGING ITS KIND, AND THAT IS
// STATED HERE RATHER THAN LEFT TO BE DISCOVERED. The unaudited input channel now
// also carries `role: 'tool'` messages — content a THIRD PARTY produced and the
// block pasted back in — plus tool descriptions and JSON Schemas the app author
// wrote. More volume and more provenance on a channel that was already
// unaudited; no new channel. It is bounded rather than audited: `MAX_TOOL_ROUNDS`
// caps how many tool results one submit can carry, and the OUTPUT scan still
// stands in front of everything the model says ABOUT a tool result before a
// block can publish it.
//
// 🔴 "`MAX_MESSAGE_CHARS` CAPS EACH" USED TO BE ON THAT LIST AND WAS WRONG.
// That constant caps each `content` field, but an assistant message ALSO
// carries up to `MAX_TOOLS` tool calls whose `arguments` each get the SAME cap,
// so one message can now reach roughly `MAX_MESSAGE_CHARS * (1 + MAX_TOOLS)`
// rather than `MAX_MESSAGE_CHARS`. Measured across the whole payload, the
// maximum accepted built step grew ~9x with tool calling (≈257k -> ≈2.32M
// chars). There is no per-message aggregate cap.
//
// 🔴 THAT IS A DELIBERATE DECLINE, NOT AN OVERSIGHT, AND HERE IS THE REASONING
// SO IT CAN BE RE-EXAMINED RATHER THAN RE-DISCOVERED. It is not a spend hole:
// prompt tokens are priced by the per-submit live quote and gated by
// `buzzBudget` before anything is reserved. It is not a CPU hole either: the
// AIR scan over a maximal ~2.3 MB payload measured ~6 ms. What it does cost is
// request size and prefill compute, driven by an untrusted iframe, on the
// ESTIMATE path as well as submit. If that becomes a problem the fix is a
// per-message aggregate cap, which is additive and cheap; it is left out today
// because a cap chosen without a real payload distribution would be a guess
// that breaks legitimate callers.
//
// 🔴 DO NOT "CLOSE" THIS BY SWITCHING TO `'promptAudit'`. The map's own inclusion
// criterion forbids exactly that trade: declaring it would audit the input and
// ship the OUTPUT unscanned, which is strictly worse than the status quo.
//
// 🔴 WHAT ACTUALLY WITHHOLDS — AN ENUMERATION, BECAUSE THE UNIVERSAL WAS FALSE.
// This header and the `moderationPosture` field both used to say the reply is
// withheld "on any scanner failure". That is NOT true of the shipped code, and
// a comment claiming a stronger safety property than the implementation is the
// thing a maintainer deletes a guard on the strength of. Read off
// `./text-output-moderation` and `./moderation` rather than restated from
// intent, the OUTPUT phase withholds on exactly these:
//
//   1. `stage: 'error'` — the scan call THREW, or `withHardDeadline` fired.
//   2. `stage: 'no-verdict'` — no `xGuardModeration` step output came back:
//      either the submit itself failed (resolves `undefined`) or the workflow
//      was still running when the `wait` window elapsed.
//   3. `stage: 'over-cap'` — the joined content exceeds
//      `MAX_SCANNED_CONTENT_CHARS` (50,000). Checked BEFORE the network call
//      and before the memo, so an over-cap payload cannot be answered from a
//      cache hit either. (This is the constant `CHAT_COMPLETION_MAX_OUTPUT_TOKENS`
//      below is derived from.)
//   4. `stage: 'label-drift'` — a REQUESTED label came back with no `results[]`
//      entry at all (`missingRequestedLabels`), even when nothing triggered.
//   5. The extractor returned a non-array, or an array containing a non-string
//      — caught in `./moderation`'s `textOutput.output` phase before any scan.
//
//   …plus the ordinary `stage: 'withheld'`: a policy-actioned label triggered
//   (an always-withhold label at any ceiling, or an SFW-only label under a green
//   ceiling). Note an EMPTY extraction is a RELEASE of zero texts, not a
//   withhold — nothing unscanned reaches the block, so there is no hazard in
//   that direction.
//
// 🔴 KNOWN GAP INSIDE THE OLD PHRASE — A PER-LABEL `error` RELEASES. The
// generated `XGuardLabelResult` carries `error?: null | string`, i.e. the
// scanner can report that it ATTEMPTED a label and FAILED on it. This side's
// read shape `XGuardLabelResultLike` declares only `label` / `score` /
// `triggered`, and `decideTextOutputVerdict` reads only those three. So an
// errored label: contributes nothing to `triggered`; still carries a `label`,
// so it lands in the `evaluated` set and the drift guard in (4) does NOT fire;
// and the verdict RELEASES. A label the scanner could not answer is therefore
// indistinguishable from a clean one — the fail-OPEN shape that
// `missingRequestedLabels` closes on the RENAME axis and does not close here.
// Stated as an OPEN gap on the tree this commit produces. A fix is in flight as
// #3609 and lives in `./text-output-moderation`; if you are reading this after
// that merged, re-derive this paragraph from the code rather than assuming it
// is stale — and delete it only once `error` is actually read.
//
// 🔴 THE AIR SCAN'S FALSE-POSITIVE SURFACE — FOR THIS ENTRY IT IS PURE PROSE,
// AND THE GUARD IS KEPT ANYWAY. READ THIS BEFORE PROPOSING TO SCOPE IT.
//
// `resourcePolicy: { kind: 'none' }` is enforced twice: at registry load
// (clause 7, over `buildStep(canonicalParamsFor(v))`) and again at request time
// in `blocks.router.ts` over the input this entry actually builds.
// `containsAirReference` is a case-insensitive SUBSTRING test for `urn:air:`
// across every string, array element, object value and object KEY.
//
// `buildStep` emits exactly `{ model, messages, maxTokens, temperature?, tools?,
// tool_choice? }` (pinned by the exact-key-set test in
// `__tests__/chat-completion.step.test.ts`). `model` is `z.enum`-bounded to
// `CHAT_COMPLETION_MODELS`, `maxTokens` and `temperature` are numbers, and
// `role` is a four-value literal set.
//
// 🔴 THE CALLER-CONTROLLED STRING SET GREW WHEN TOOLS SHIPPED, AND AN EARLIER
// REVISION OF THIS PARAGRAPH NAMED ONLY ONE OF THEM. It said "**`messages[].content`
// is the only string in the built input that an untrusted iframe can put
// arbitrary text into**". That is now FALSE. The full set is:
//   * `messages[].content` — human prose, as before;
//   * `messages[].tool_calls[].function.arguments` and `.id` on a replayed
//     assistant turn, and `messages[].tool_call_id` on a tool result;
//   * `tools[].function.description` — free text the app author writes;
//   * `tools[].function.parameters` — an arbitrary JSON Schema, every string
//     and KEY inside it included.
// Names are pattern-bounded (`TOOL_NAME_PATTERN`) and so cannot carry the
// literal, but everything else above can. For this entry the guard therefore
// reduces to: reject any of those carrying the literal `urn:air:`. A user asking
// "what does urn:air: mean?" still gets a hard FORBIDDEN, and so now does a tool
// whose description mentions AIRs — which is a REAL cost for a catalog toolset,
// because catalog data is exactly where AIRs live. The fail-closed direction is
// unchanged and deliberate; the fix belongs in what the caller puts in the
// payload, not in narrowing the scan (see the paragraph below on why).
//
// 🔴 AND `parameters` IS WHY THE JSON ROUND-TRIP IN `toolParametersSchema` IS
// LOAD-BEARING RATHER THAN TIDY. `containsAirReference` documents its own
// totality limit at `toJSON`-bearing class instances, and names "the first time
// an entry declares a `z.unknown()` / `z.any()` / `z.custom()` param" as the
// point that becomes reachable. This entry is that entry. The normalisation
// there is what keeps the value the scan walks identical to the value that
// reaches the wire.
//
// WHAT THE ORCHESTRATOR ACTUALLY DOES WITH THAT PROSE — read from
// `civitai/civitai-orchestration` at `origin/main` e9ce862cb, not assumed:
//   * `ChatCompletionContentPartJsonConverter.Read` turns a JSON string content
//     into a single `ChatCompletionContentPart { Text = s, ImageUrl = null }`,
//     so string content can never enter the image path at all.
//   * `ChatCompletionInput.OnInitializedAsync` is the only lifecycle hook that
//     walks `Messages`, and it acts solely on `part.ImageUrl` (handing it to
//     `ISourceImageProcessor`). It never reads `part.Text`.
//   * `ChatCompletionHandler.CalculateCostAsync` holds the ONLY `urn:air:` test
//     in the whole chat step — `input.Model.StartsWith("urn:air:")`, which
//     selects the AIR-model cost branch. It is a test of `Model`, never of
//     `Messages`, and this entry's `z.enum` makes that branch unreachable.
//   * `GenerateJobsAsync` copies `input.Messages` verbatim onto
//     `ChatCompletionJob` for the worker.
// i.e. an AIR inside `messages[].content` is inert text on that revision — it
// resolves no resource and reaches no entitlement-bearing field.
//
// 🔴 WHY THAT IS STILL NOT ENOUGH TO SCOPE THE SCAN. That paragraph is a claim
// about the CURRENT source of a SEPARATELY DEPLOYED service. Nothing in this
// repo can hold it true: the generated `@civitai/client` types encode the SHAPE
// of `ChatCompletionInput`, never which of its fields get resolved, so an
// orchestrator change that started resolving AIRs mentioned in prompt text
// would turn a per-entry "don't scan `messages`" exemption into a silent
// entitlement bypass with nothing going red on this side. The worker that
// finally receives `ChatCompletionJob.Messages` lives outside that repo and was
// not read at all. The asymmetry decides it: a false positive costs ONE bounced
// message and is fixable BY THE APP — `messages[].content` is assembled by the
// block, which can strip or escape the literal before submitting — while an
// entitlement bypass is not recoverable by anyone. So the scan stays total, and
// the router's rejection message now says plainly that it matched a literal
// substring rather than claiming the step "carries an AIR reference".
//
// If you do scope it later, the narrow shape is a per-entry declaration that
// DEFAULTS to scan-everything, and it owes evidence that survives the paragraph
// above — not a re-reading of the same orchestrator source.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The declared price floor, in Buzz. NOT the price.
 *
 * 🔴 THIS COMMENT USED TO SAY THE PRICE WAS "MEASURED, not declared" — that
 * `cost.total = 1` had been observed "for every model in
 * `CHAT_COMPLETION_MODELS` and for `maxTokens` from 1 to 200,000". THAT WAS
 * FALSE, and it was cited rather than re-derived for as long as it stood.
 * Re-measured 2026-08-27 by `whatif` quote against the live orchestrator: the
 * real price is SEVERAL times this constant for an ordinary conversation, it
 * differs per model, and it rises with `maxTokens`.
 *
 * WHY NO CONSTANT CAN BE RIGHT. Every model in `CHAT_COMPLETION_MODELS` is a
 * third-party model that the orchestrator prices per token, so the charge moves
 * with the model, the conversation and `maxTokens` — none of which this repo can
 * see, and none of which a constant can track. The pricing itself is the
 * orchestrator's and is deliberately not restated here; the figures and the
 * derivation are in the internal tracker. The one part of it this constant IS:
 * the orchestrator floors the price at 1, and that floor is what this number
 * means — nothing more.
 *
 * 🔴 IT IS NOT WHAT THE BLOCK IS SHOWN ANY MORE, EITHER. `estimateStepWorkflow`
 * now quotes the orchestrator and falls back to this only when no quote can be
 * had, so a block sees the live price rather than this floor. The registry's
 * load-time invariant still forces `estimateBuzz === priceForVariant`, which is
 * why both still return it: they are the fallback and the reservation floor.
 *
 * 🔴 It is NOT the enforced ceiling. The step submit path runs its own `whatif`
 * before the per-call `buzzBudget` gate and reserves `max(declared, quoted)`, so
 * a rate-card change is caught at submit rather than by a human reading a
 * counter later. See the ORCHESTRATOR QUOTE section in `blocks.router.ts`.
 *
 * 🔴 DO NOT "CORRECT" THIS TO A BIGGER NUMBER. It is not a stale value that
 * wants a newer one; it is the wrong SHAPE for a usage-priced step. Raising it
 * would make the reservation floor over-reserve on cheap models and still
 * under-declare on expensive ones, and would go stale again on the next
 * upstream rate move.
 */
export const CHAT_COMPLETION_PRICE_BUZZ = 1;

/**
 * The models this entry may reach — the allowlist, the variant set, and the
 * per-model pricing key, all one declaration.
 *
 * 🔴 A NON-MEMBER IS REJECTED AT PARSE (`z.enum` below), before
 * `resolveStepVariant` is ever reached. That ordering is deliberate: the
 * variant guard's error message echoes `variants.join(', ')` to the untrusted
 * iframe, so an entry whose model list is not public information would be
 * disclosing it. Every id here IS public, and the schema makes the guard
 * unreachable anyway — but the next person adding an unreleased model to this
 * list should know both facts.
 *
 * v1 is deliberately three. All three were driven to `succeeded` against the
 * live orchestrator; adding a fourth later is a one-line additive change.
 *
 * 🔴 `cognitivecomputations/dolphin-mistral-24b-venice-edition` IS AN UNCENSORED
 * MODEL, and it is listed on purpose. Its output is not trusted — it is scanned
 * exactly like every other model's, by the posture: `NSFW` / `Suggestive` /
 * `Explicit` withhold on a SFW maturity ceiling and release above it, while the
 * always-withhold labels (`Young`, `Grooming`, `Sex Trafficking`,
 * `Exploitation`, `Bestiality`, `Extremism`, `Impersonating Civitai Staff`)
 * apply at every ceiling. That is the designed behaviour of `'textOutput'`, not
 * a gap this entry is exploiting.
 */
export const CHAT_COMPLETION_MODELS = [
  'deepseek/deepseek-chat',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition',
  'openai/gpt-4o-mini',
] as const;

export type ChatCompletionModel = (typeof CHAT_COMPLETION_MODELS)[number];

/**
 * The hard ceiling on generated tokens.
 *
 * 🔴 DERIVED FROM THE SCAN CAP, NOT PICKED. `MAX_SCANNED_CONTENT_CHARS` in
 * `./text-output-moderation` is **50,000**, and content ABOVE that cap is a
 * WITHHOLD, not a truncation — so any `maxTokens` ceiling that can produce more
 * than 50,000 characters designs a guaranteed withhold into the capability: the
 * app pays 1 Buzz, the model generates, and the reader gets nothing.
 *
 * At the nominal ~4 characters per token, 4,000 tokens is ~16,000 characters —
 * about a third of the cap, leaving ~3× headroom for content whose real
 * characters-per-token runs far above the nominal (long whitespace runs and
 * repeated substrings merge into single BPE tokens). The cap would only be
 * reached at ~12.5 chars/token sustained across the whole reply.
 *
 * 🔴 THE TWO NUMBERS ARE PINNED TOGETHER BY A TEST, DELIBERATELY NOT BY AN
 * IMPORT. Importing `MAX_SCANNED_CONTENT_CHARS` here would drag
 * `./text-output-moderation` — and through it `orchestrator.service` — onto the
 * registry's module-load path, which `workflow.schema` depends on staying light.
 * So the link is asserted in `__tests__/chat-completion.step.test.ts`, which
 * imports both and goes RED if either constant moves. If you change one, that
 * test is what tells you about the other.
 */
export const CHAT_COMPLETION_MAX_OUTPUT_TOKENS = 4_000;

/** The nominal characters-per-token used in the derivation above. Exported so the test can pin it. */
export const CHAT_COMPLETION_ASSUMED_CHARS_PER_TOKEN = 4;

/**
 * Input bounds on the conversation.
 *
 * These bound PREFILL compute, which the flat 1-Buzz price does not. They are
 * generous enough for a real chat block and small enough that an app cannot
 * turn a 1-Buzz call into an arbitrarily large prompt. Widening later is
 * additive; narrowing is breaking.
 */
const MAX_MESSAGES = 32;
/**
 * EXPORTED so the tool surface's result budget can be asserted against it.
 *
 * `~/server/services/blocks/tools/registry` bounds a tool RESULT to a value that
 * must stay strictly below this, because the block replays that result as a
 * `role: 'tool'` message whose `content` this cap bounds — a larger result is
 * un-replayable and therefore useless. That module is deliberately
 * server-import-free and so cannot import this one; the link is asserted in its
 * test instead, which imports BOTH and goes red if either constant moves. Same
 * technique this file already uses for its link to `MAX_SCANNED_CONTENT_CHARS`.
 */
export const MAX_MESSAGE_CHARS = 8_000;

/** Sampling temperature bounds, taken from `ChatCompletionInput.temperature`'s own documented range. */
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;

/**
 * The maximum number of `role: 'tool'` messages one submit may carry — i.e. the
 * bound on how many tool ROUNDS a conversation can accumulate.
 *
 * 🔴 BE EXACT ABOUT WHAT THIS BOUNDS: HISTORY DEPTH IN ONE PAYLOAD. It is NOT
 * a bound on the conversation, and it is NOT what keeps the entry billable as
 * `prepaidFixed`. An earlier revision of this comment called it "THE BILLING
 * BOUND, AND WHY THE ENTRY CAN STAY `prepaidFixed`" and said "a caller cannot
 * loop past it" — both were stronger than the code, and a reader relying on
 * either would be wrong. A block that drops or summarises the oldest tool
 * result keeps every payload at or under this cap and can submit
 * INDEFINITELY; nothing counts rounds across submits, because submits are
 * independent requests.
 *
 * WHAT ACTUALLY BOUNDS THE MONEY, and it is sound: each round is its own
 * submit — this entry does NOT loop server-side, the block drives the loop by
 * appending the tool result and submitting again — so every round gets its own
 * live orchestrator quote (`whatif:true` on the exact step about to be
 * submitted, reserving `max(declared, quoted)`), its own per-call `buzzBudget`
 * gate, and its own reservation against the per-user daily cap, the per-app
 * aggregate cap and the dev-session cap. That is what makes "cost knowable
 * before execution" true per submit, and it is what stops a runaway loop —
 * this constant is not load-bearing for either.
 *
 * 🔴 "ROUNDS" IS ALSO NOT "TOOL CALLS". An assistant turn's `tool_calls` array
 * is capped by `MAX_TOOLS`, so a single submit can request that many tool
 * executions while counting as one round — and a payload at this cap can carry
 * several times that many calls in total. If you need to bound executions
 * rather than history depth, this is the wrong constant.
 *
 * 🔴 ENFORCED AT PARSE, NOT IN THE BLOCK, AND THAT PLACEMENT IS STILL THE
 * POINT. A block is untrusted sandboxed code, so a cap it applies to itself is
 * not a cap. `parseStepParams` runs this schema on BOTH the estimate and the
 * submit path, so the two cannot disagree about what is accepted. It rejects as
 * BAD_REQUEST before the orchestrator quote and before every reservation, so a
 * rejection costs no round-trip and has nothing to refund.
 *
 * WHY THREE. Two rounds cover the shape this exists for — call a catalog tool,
 * read the result, answer — and the third leaves room for one refinement when
 * the first query comes back empty, which is the whole argument for real tool
 * calling over a one-shot heuristic. Raising it is additive and cheap; lowering
 * it is breaking. It is deliberately far below the incidental ceiling
 * `MAX_MESSAGES` already imposes (32 messages ≈ 15 rounds at 2 messages each),
 * because that ceiling is neither stated nor intentional.
 */
export const MAX_TOOL_ROUNDS = 3;

/**
 * Bounds on the TOOL DEFINITIONS a caller may attach.
 *
 * 🔴 THESE ARE COMPUTE/LATENCY BOUNDS, NOT PRICE BOUNDS, AND THE DIFFERENCE
 * MATTERS. Tool definitions inflate PROMPT tokens — the orchestrator estimates
 * them explicitly — but the submit path quotes the orchestrator for the exact
 * step it submits, and `tools` is inside that step, so the inflation is PRICED
 * before the per-call budget gate rather than escaping it. What these bounds
 * protect is the thing the quote does not: prefill compute and request size
 * driven by an untrusted iframe.
 *
 * `MAX_TOOLS` is 8 because the read-only catalog toolset this capability exists
 * to serve is seven tools; eight leaves one slot without inviting a caller to
 * ship a toolbox as a prompt.
 *
 * `MAX_TOOL_PARAMETERS_DEPTH` is the one bound with a second, sharper reason.
 * The built step is deep-scanned by `containsAirReference` (registry clause 7
 * at load, and again request-time in `blocks.router.ts`), which recurses with a
 * fail-CLOSED cap at `AIR_SCAN_MAX_DEPTH`: past that depth it returns TRUE. A
 * caller-supplied JSON schema is now part of that scanned input, so without a
 * parse-time depth cap an over-nested `parameters` object would be rejected as
 * "contains an AIR reference" — a confidently wrong diagnostic for a payload
 * with no AIR in it. Capping here, far below the scan's own cap, makes the
 * error say what is actually wrong.
 */
const MAX_TOOLS = 8;
const MAX_TOOL_NAME_CHARS = 64;
const MAX_TOOL_DESCRIPTION_CHARS = 1_024;
const MAX_TOOL_PARAMETERS_CHARS = 4_096;
const MAX_TOOL_PARAMETERS_DEPTH = 8;

/**
 * The characters a tool NAME may contain.
 *
 * 🔴 A PATTERN, NOT MERELY A LENGTH, AND THAT IS LOAD-BEARING DOWNSTREAM. The
 * name comes back on the model's `tool_calls[]` and `extractToolCalls` publishes
 * it to the block WITHOUT it having been through the text scan — which is only
 * defensible because a name matching this pattern cannot carry prose. If this is
 * ever widened to admit spaces or punctuation, the name becomes a free-text
 * surface and has to join the scanned set. The character class also matches the
 * one OpenAI documents for function names, so a bounded name is not a
 * civitai-specific restriction a caller has to discover.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * A tool's JSON-Schema `parameters` object — bounded, and NORMALISED THROUGH
 * JSON.
 *
 * 🔴 THE ROUND-TRIP IS THE WHOLE POINT, NOT A TIDY-UP. `./index`'s
 * `containsAirReference` documents an exact limit on its own totality: its
 * "scan every string anywhere" guarantee holds because `Object.entries`
 * visibility matches `JSON.stringify` visibility — EXCEPT for `toJSON`-bearing
 * class instances, where it does not. The measured example in that docstring is
 * `new URL('https://x/urn:air:…')`, for which `containsAirReference` returns
 * FALSE while `JSON.stringify` of it CONTAINS the AIR. That note names the
 * precondition for the hazard becoming reachable: "the first time an entry
 * declares a `z.unknown()` / `z.any()` / `z.custom()` param", because superjson
 * reconstructs a `URL` across the tRPC boundary.
 *
 * THIS IS THAT ENTRY. A tool's `parameters` is an arbitrary JSON Schema, so it
 * cannot be given a field-by-field shape — and a naive structural walk does NOT
 * close the hole, because `Object.keys(new URL(…))` is `[]`: the instance reads
 * as a harmless empty object and then serialises to its full href on the wire.
 *
 * So this validates the SERIALISED form and returns the PARSED-BACK value. After
 * it, `parameters` is pure JSON data by construction, which makes what the AIR
 * scan walks byte-identical to what reaches the orchestrator. That is exactly
 * the "pre-scan `JSON.parse(JSON.stringify(input))` normalisation" the registry
 * note prescribes, paid here where the unbounded value enters rather than left
 * for the scan to be wrong about.
 *
 * `JSON.stringify` also THROWS for several distinct reasons — a circular
 * structure, a `BigInt`, a throwing getter, a throwing `toJSON` — and returns
 * `undefined` for a bare function/symbol; all are caught and rejected rather
 * than allowed to surface as a 500 from inside the resolver. 🔴 The rejection
 * message names the CLASS rather than guessing the cause: it used to say "a
 * circular structure was rejected" for every throw, which is a confidently
 * wrong diagnostic for the `BigInt` and throwing-`toJSON` cases and sends an
 * app author looking for a cycle that is not there.
 */
const toolParametersSchema = z.unknown().transform((value, ctx) => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (e) {
    ctx.addIssue({
      code: 'custom',
      message:
        'tool parameters must be JSON-serializable — serializing them threw ' +
        `(${e instanceof Error ? e.message : String(e)}). Common causes: a circular reference, ` +
        'a BigInt, or a getter/toJSON that throws',
    });
    return z.NEVER;
  }
  if (typeof serialized !== 'string') {
    ctx.addIssue({
      code: 'custom',
      message: 'tool parameters must be a JSON value, not a function or symbol',
    });
    return z.NEVER;
  }
  if (serialized.length > MAX_TOOL_PARAMETERS_CHARS) {
    ctx.addIssue({
      code: 'custom',
      message: `tool parameters exceed ${MAX_TOOL_PARAMETERS_CHARS} serialized characters`,
    });
    return z.NEVER;
  }
  const normalized: unknown = JSON.parse(serialized);
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    ctx.addIssue({
      code: 'custom',
      message: 'tool parameters must be a JSON Schema object',
    });
    return z.NEVER;
  }
  if (jsonDepth(normalized) > MAX_TOOL_PARAMETERS_DEPTH) {
    ctx.addIssue({
      code: 'custom',
      message: `tool parameters nest deeper than ${MAX_TOOL_PARAMETERS_DEPTH} levels`,
    });
    return z.NEVER;
  }
  return normalized as Record<string, unknown>;
});

/**
 * Nesting depth of an already-JSON-normalised value.
 *
 * Total by construction rather than by a depth cap: it only ever runs on the
 * output of `JSON.parse`, which cannot be circular, and the serialized-size cap
 * above bounds how much there is to walk before this is reached.
 */
function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + value.reduce<number>((max, v) => Math.max(max, jsonDepth(v)), 0);
  }
  if (value !== null && typeof value === 'object') {
    return (
      1 +
      Object.values(value as Record<string, unknown>).reduce<number>(
        (max, v) => Math.max(max, jsonDepth(v)),
        0
      )
    );
  }
  return 0;
}

/**
 * One tool the model may call.
 *
 * Anchored to the generated `ChatCompletionTool` / `ChatCompletionFunction` by
 * NAME only — see `ChatCompletionInputWithTools` for why the generated TYPES
 * cannot be used directly here.
 *
 * The tool-level `parameters` field the generated `ChatCompletionTool` also
 * carries ("Server-tool parameters for providers such as OpenRouter") is
 * deliberately NOT exposed: the JSON Schema belongs on `function.parameters`,
 * and a second unbounded object with a different meaning is a surface this entry
 * has no use for. `.strict()` rejects it.
 */
const chatToolSchema = z
  .object({
    type: z.literal('function'),
    function: z
      .object({
        name: z.string().min(1).max(MAX_TOOL_NAME_CHARS).regex(TOOL_NAME_PATTERN),
        description: z.string().min(1).max(MAX_TOOL_DESCRIPTION_CHARS).optional(),
        parameters: toolParametersSchema.optional(),
      })
      .strict(),
  })
  .strict();

/**
 * Which tool the model must call, if any.
 *
 * Bounded to the three documented string modes plus the "call this specific
 * function" object form. The named form is cross-checked against the declared
 * `tools` in the params-level refinement below — naming a function that was
 * never declared is a caller mistake that would otherwise reach the provider and
 * fail there, after the step had been quoted and charged.
 */
const chatToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z
    .object({
      type: z.literal('function'),
      function: z
        .object({ name: z.string().min(1).max(MAX_TOOL_NAME_CHARS).regex(TOOL_NAME_PATTERN) })
        .strict(),
    })
    .strict(),
]);

/**
 * One conversation turn — a DISCRIMINATED UNION on `role`, every member
 * `.strict()`.
 *
 * 🔴 IT USED TO BE A SINGLE FLAT OBJECT WITH A THREE-VALUE `role` ENUM, and the
 * old docstring ended "`.strict()`, so `name`, `tool_calls` and `images` are
 * rejected rather than forwarded". That sentence is now true of only two of
 * those three: `tool_calls` is ACCEPTED on an assistant turn, because a tool
 * result cannot be fed back without replaying the assistant turn that requested
 * it. `name` and `images` are still rejected, and `images` deliberately so — see
 * the `modalities` note below.
 *
 * 🔴 `content` IS A PLAIN STRING, and that is measured rather than read off the
 * generated type. `UserMessage.content` is typed `Array<ChatCompletionContentPart>`
 * in `@civitai/client`, but the orchestrator accepts a bare string and converts
 * it to a single text part — its own doc string on that field says so ("can be a
 * simple string or array of content parts"), and a live submit with string
 * content returned HTTP 200 and polled to `succeeded`. A string is also the only
 * shape this entry WANTS: `ChatCompletionContentPart` carries `imageUrl`, which
 * would put an arbitrary remote URL the orchestrator FETCHES onto the wire from
 * an untrusted iframe — the SSRF primitive `convert-image` bounds with
 * `civitaiHostedImageUrlSchema`. Not exposing the part array avoids the question
 * entirely.
 *
 * 🔴 THE ASSISTANT MEMBER IS THE ONE WITH A REFINEMENT, AND IT IS NOT
 * COSMETIC. Both its fields are optional individually — a replayed assistant
 * turn that requested a tool carries `tool_calls` and NO content (the measured
 * shape: a real reply with `finishReason: 'tool_calls'` has no `content` key at
 * all), while an ordinary turn carries content and no tool calls. But a member
 * with both omitted is an empty message: it costs prompt tokens, means nothing
 * to the model, and is the shape a buggy block sends when its history-building
 * drops a field. Requiring at least one is what stops "I sent the history" and
 * "I sent 32 empty objects" from being the same request.
 */
const chatMessageSchema = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('system'),
      content: z.string().min(1).max(MAX_MESSAGE_CHARS),
    })
    .strict(),
  z
    .object({
      role: z.literal('user'),
      content: z.string().min(1).max(MAX_MESSAGE_CHARS),
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string().min(1).max(MAX_MESSAGE_CHARS).optional(),
      tool_calls: z
        .array(
          z
            .object({
              /**
               * 🔴 SAME CHARSET AS THE OUTPUT EXTRACTOR PUBLISHES, deliberately.
               * The file used to hold two disagreeing definitions of a valid id:
               * `call:with:colons` PARSED here while `extractToolCalls` refused
               * it on the way out. Reconciled toward the stricter one.
               *
               * 🔴 BE EXACT ABOUT WHAT THAT DOES NOT REJECT, BECAUSE AN EARLIER
               * REVISION OVERCLAIMED IT. It said this "cannot reject a
               * legitimate payload". The true guarantee is narrower: it cannot
               * reject a payload DERIVED FROM OUR OWN OUTPUT, because we publish
               * only charset-conforming ids (see `publishableToolCalls`).
               *
               * It CAN reject a hand-authored one. A block author writing
               * few-shot tool-call history — an ordinary thing to do — may
               * invent any id; `call.1` and `call:1` parsed before this
               * tightening and are now `BAD_REQUEST`. That is accepted
               * deliberately: the cost is one bounced request with a zod message
               * naming the field, against a charset that must stay aligned with
               * what the extractor will publish, or the two definitions diverge
               * again. An author hitting it renames the id and moves on.
               */
              id: z.string().min(1).max(MAX_TOOL_NAME_CHARS).regex(TOOL_NAME_PATTERN),
              type: z.literal('function'),
              function: z
                .object({
                  name: z.string().min(1).max(MAX_TOOL_NAME_CHARS).regex(TOOL_NAME_PATTERN),
                  arguments: z.string().max(MAX_MESSAGE_CHARS),
                })
                .strict(),
            })
            .strict()
        )
        .min(1)
        .max(MAX_TOOLS)
        .optional(),
    })
    .strict()
    .refine((m) => m.content !== undefined || m.tool_calls !== undefined, {
      message: 'an assistant message must carry content, tool_calls, or both',
    }),
  z
    .object({
      role: z.literal('tool'),
      content: z.string().min(1).max(MAX_MESSAGE_CHARS),
      /**
       * REQUIRED. `ToolMessage.tool_call_id` is required on the orchestrator's
       * own generated type, and a tool result with nothing to correlate it to is
       * a result the model cannot attach to the call it made.
       *
       * 🔴 LENGTH-BOUNDED BUT DELIBERATELY **NOT** CHARSET-BOUNDED, AND THE
       * CHARSET REGEX THAT USED TO BE HERE WAS REMOVED RATHER THAN DOCUMENTED.
       *
       * It changed NO accept/reject outcome. `declaredCallIds` is populated only
       * from assistant `tool_calls[].id`, which IS charset-bounded above, so a
       * charset-violating `tool_call_id` can never be a member of that set and
       * the correlation guard rejects it either way. Measured twice: removing
       * this regex alone left the suite green, and no input was found for which
       * it was the sole rejector.
       *
       * Its one observable effect was making the diagnostic WORSE — the caller
       * got a zod regex issue on a field instead of the correlation guard's
       * message naming the id and saying no preceding assistant message
       * declared it, which is the sentence that actually tells an app author
       * what to change. A redundant clause that degrades the error is a net
       * negative, so it is gone.
       *
       * The LENGTH bound stays: it is not redundant in the same way. It bounds
       * the payload before correlation runs, rather than admitting an
       * arbitrarily long string that correlation would then reject.
       */
      tool_call_id: z.string().min(1).max(MAX_TOOL_NAME_CHARS),
    })
    .strict(),
]);

const chatCompletionParamsSchema = z
  .object({
    /**
     * 🔴 THE ALLOWLIST. A `z.enum` over `CHAT_COMPLETION_MODELS`, which is also
     * the entry's `variants` — so membership is enforced twice, at parse and
     * again by `resolveStepVariant`, and the resolved value is what the audit
     * row records as `detail.variant`.
     */
    model: z.enum(CHAT_COMPLETION_MODELS),
    messages: z.array(chatMessageSchema).min(1).max(MAX_MESSAGES),
    /** Tool definitions the model may call. See `MAX_TOOLS` for the bounds' reasoning. */
    tools: z.array(chatToolSchema).min(1).max(MAX_TOOLS).optional(),
    /** Which tool the model must call, if any. Requires `tools`. */
    toolChoice: chatToolChoiceSchema.optional(),
    /**
     * 🔴 REQUIRED, NEVER `.optional()`, AND THAT IS THE POINT OF THE FIELD.
     * `.strict()` rejects params it does not know about; it does NOT bound a
     * param the caller simply OMITS. An omitted `maxTokens` falls through to the
     * orchestrator's own default, which nothing on this side bounds — and since
     * the price is FLAT at 1 Buzz from 1 token to 200,000 (measured), an
     * unbounded token count is unbounded compute at a fixed price, plus a
     * guaranteed `over-cap` withhold once the reply passes 50,000 characters.
     *
     * Required rather than `.default(...)` because a default is a compute budget
     * the app author never chose and — the price being flat — would never see a
     * cost signal for. Making it explicit is the narrower surface; adding a
     * default later is additive, removing one is breaking.
     */
    maxTokens: z.number().int().min(1).max(CHAT_COMPLETION_MAX_OUTPUT_TOKENS),
    /**
     * Optional, and that is NOT in tension with the `maxTokens` rule above — the
     * hazard there is unbounded RESOURCE consumption behind an omitted value,
     * and an omitted temperature falls through to a provider default that is a
     * sampling knob inside this same 0–2 range. It consumes nothing.
     */
    temperature: z.number().min(TEMPERATURE_MIN).max(TEMPERATURE_MAX).optional(),
  })
  .strict()
  .superRefine((params, ctx) => {
    // ── THE ROUND BOUND. See `MAX_TOOL_ROUNDS` for why it exists and why it is
    // enforced here rather than in the block. Counting `role: 'tool'` messages
    // counts completed rounds: a round is "the model asked for a tool, the tool
    // answered", and the answer is the `tool` message.
    const toolRounds = params.messages.filter((m) => m.role === 'tool').length;
    if (toolRounds > MAX_TOOL_ROUNDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['messages'],
        message:
          `too many tool rounds: ${toolRounds} tool messages exceeds the maximum of ` +
          `${MAX_TOOL_ROUNDS}. Each round is a separate billed submit, so the loop is bounded ` +
          'here rather than by the caller',
      });
    }

    // ── A TOOL RESULT MUST ANSWER A TOOL CALL THAT WAS ACTUALLY MADE, AND MUST
    // COME AFTER IT. Exactly the reasoning the `toolChoice` clause below
    // applies to an undeclared function name, on the axis the provider is just
    // as strict about: an OpenAI-compatible provider rejects a `tool` message
    // whose `tool_call_id` matches no preceding assistant `tool_calls[].id`,
    // and rejects one with no preceding assistant turn at all. There is no
    // orchestrator-side validation that catches either before execution, so
    // without this the payload is QUOTED, RESERVED against every cap, CHARGED,
    // and only then fails at the provider — with a block-side error the app
    // author cannot diagnose. Rejecting at parse costs no round-trip and has
    // nothing to refund.
    //
    // 🔴 THE SET IS BUILT IN ORDER, WHICH IS WHAT MAKES THIS AN ORDERING CHECK
    // AND NOT MERELY A MEMBERSHIP ONE. Collecting every id first and then
    // testing membership would accept a `tool` message that PRECEDES the
    // assistant turn declaring it — a payload the provider still rejects.
    //
    // 🔴 THIS GUARD COVERS ONE DIRECTION ONLY, AND THE OTHER IS A KNOWN,
    // UNVALIDATED GAP. It constrains ANSWERS to declared ASKS. It does not
    // constrain asks to be answered, and it does not deduplicate. **This schema
    // therefore ACCEPTS all three of the following** — stated as what the schema
    // does, not as a claim that they are legal at the provider:
    //
    //   1. `[user, assistant(tool_calls:[a])]`             — an ask never answered
    //   2. `[user, assistant(tool_calls:[a]), user, tool(a)]` — answer split from its ask
    //   3. `[user, assistant(tool_calls:[a]), tool(a), tool(a)]` — one ask answered twice
    //
    // 🔴 AN EARLIER REVISION CALLED (1) "legal, since the correlation guard
    // constrains answers to declared asks and not the reverse". That sentence
    // was a true statement about THIS SCHEMA'S ACCEPTANCE worded as a claim
    // about the PROVIDER, which is not ours to make.
    //
    // No guard is added for these deliberately. The premise that providers
    // reject them comes from the OpenAI-compatible contract, NOT from a probe
    // against this orchestrator — and the wire spelling of the tool fields is
    // itself still unconfirmed against a live request. A guard built on an
    // unverified premise risks being TOO STRICT and rejecting payloads that
    // actually work, which is the worse failure here: the cost of the gap is a
    // charged submit plus a provider error, while the cost of a wrong guard is a
    // working feature refused at parse. Close this once the live probe settles
    // what the orchestrator accepts.
    const declaredCallIds = new Set<string>();
    for (const message of params.messages) {
      if (message.role === 'assistant') {
        for (const call of message.tool_calls ?? []) declaredCallIds.add(call.id);
        continue;
      }
      if (message.role !== 'tool') continue;
      if (!declaredCallIds.has(message.tool_call_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['messages'],
          message:
            `tool message references tool_call_id '${message.tool_call_id}', which no PRECEDING ` +
            'assistant message declared in tool_calls. A tool result must answer a tool call ' +
            'that was actually made, and must come after it',
        });
      }
    }

    // ── `toolChoice` WITHOUT `tools` IS A NO-OP THE CALLER WILL MISREAD.
    // "required" with nothing to require is not a stricter request, it is a
    // request the provider cannot satisfy — rejected here so it fails before the
    // step is quoted rather than at execution after it has been charged.
    if (params.toolChoice !== undefined && params.tools === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['toolChoice'],
        message: 'toolChoice requires tools to be declared',
      });
    }

    // ── A NAMED FUNCTION MUST BE ONE THAT WAS DECLARED. Same reasoning as the
    // model allowlist: there is no orchestrator-side validation to catch it, so
    // an undeclared name is quoted, charged, and then fails at the provider.
    const namedFunction =
      typeof params.toolChoice === 'object' ? params.toolChoice.function.name : undefined;
    if (
      namedFunction !== undefined &&
      params.tools !== undefined &&
      !params.tools.some((t) => t.function.name === namedFunction)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['toolChoice', 'function', 'name'],
        message: 'toolChoice names a function that is not in tools',
      });
    }
  });

export type ChatCompletionStepParams = z.infer<typeof chatCompletionParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE SINGLE MOST IMPORTANT LINE IN THIS FILE: `modalities` IS NOT EXPOSED,
// AND `buildStep` NEVER SETS IT.
//
// `ChatCompletionInput.modalities` accepts `['image']`, and when it is present
// the orchestrator routes the request to the IMAGE pipeline and returns
// generated images on `choices[].message.images[].image_url.url` as **base64
// data URIs** (`ChatCompletionGeneratedImage` / `ChatCompletionGeneratedImageUrl`
// in the generated types). Those bytes never touch image ingestion, so they
// never become moderated `Image` rows, never get an `nsfwLevel`, and never meet
// any media gate — and the text scan does not look at media at all.
//
// Omitting the field is what makes this entry HONESTLY text-only, and it is what
// keeps the registry's MEDIA-XOR-TEXT model (`stepOutputShape`) true for it: a
// `'textOutput'` entry has no `extractOutput` by construction, so anything the
// step produced that is not text has no channel to the block at all. Adding
// `modalities` (or its companion `image_config`) to the schema would silently
// make this a media-producing step wearing a text posture — the exact
// half-covered shape `./index`'s XOR note says must fail at load rather than
// half-register.
//
// The schema is `.strict()`, so a block passing `modalities` today gets a
// BAD_REQUEST at parse. `buildStep` below emits an EXACT key set, pinned by a
// test, so a future edit that adds the field fails a test rather than shipping.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ChatCompletionInput` with its two TOOL fields corrected.
 *
 * 🔴 THE GENERATED TYPES CANNOT EXPRESS A TOOL CALL, AND THAT IS A GENERATOR
 * ARTIFACT RATHER THAN A CONTRACT. Read off `@civitai/client`'s `types.gen.d.ts`
 * at the version this repo pins:
 *
 *     ChatCompletionInput.tool_choice?: null;
 *     ChatCompletionTool.parameters?:   null;
 *     ChatCompletionFunction.parameters?: null;
 *
 * All three are `null` — not `unknown`, not a schema type. The C# side holds
 * them as free-form JSON, and the OpenAPI generator emits an untyped
 * schema-less field as `null`. Their own doc comments contradict the types they
 * carry: `tool_choice`'s says it "Can be \"auto\", \"none\", \"required\", or an
 * object specifying a particular function", and `ChatCompletionTool.parameters`
 * is documented as "Server-tool parameters for providers such as OpenRouter".
 *
 * So the generated type says a tool call is impossible while the generated DOC
 * says how to make one, and the wire accepts it — a real submit carrying a
 * `tools` array and a tool choice was accepted, echoed back in the
 * orchestrator's normalised input, and priced (its tool-definition token
 * estimator is a first-class part of its cost path).
 *
 * 🔴 WHY A NARROW INTERSECTION AND NOT A CAST. `buildChatCompletionInput`'s
 * declared return type is the anchor that makes every field NAME load-bearing —
 * a rename on the orchestrator's input contract is a build failure here rather
 * than a request the orchestrator silently ignores. An `as ChatCompletionInput`
 * would throw that away for the whole object to fix two fields. `Omit`-ing
 * exactly the two lossy fields and re-declaring them keeps `model`, `messages`,
 * `maxTokens` and `temperature` anchored, and records IN THE TYPE which two
 * fields this repo is not able to check against the generator.
 *
 * 🔴 IF THE GENERATOR IS EVER FIXED, DELETE THIS. Once `tool_choice` and
 * `parameters` carry real types upstream, the `Omit` starts hiding a contract
 * this file could otherwise be checked against — at which point it is no longer
 * a workaround, it is the thing it was written to avoid.
 */
type ChatCompletionToolChoiceWire =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

type ChatCompletionInputWithTools = Omit<ChatCompletionInput, 'tools' | 'tool_choice'> & {
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
  }>;
  tool_choice?: ChatCompletionToolChoiceWire;
};

/**
 * The bounded input this entry submits, ANCHORED to the generated
 * `ChatCompletionInput` (with the two documented exceptions above).
 *
 * Declaring the return type is what makes the field NAMES load-bearing: a
 * renamed or retyped field on the orchestrator's own input contract is a build
 * failure here rather than a request the orchestrator ignores. `messages` is
 * anchored to `ChatCompletionInput`'s own `Array<ChatCompletionMessage>` (the
 * `{ role: string }` base) rather than to `UserMessage`, because that alias's
 * `content: Array<ChatCompletionContentPart>` contradicts the measured wire
 * behaviour — see `chatMessageSchema`.
 *
 * 🔴 THE WIRE NAME IS `tool_choice`, SNAKE-CASED, WHILE THE PARAM IS
 * `toolChoice`. That asymmetry is deliberate and is read off the generated type,
 * not chosen: this input mixes conventions — `maxTokens` is camelCase while
 * every tool-related field (`tool_choice`, `tool_calls`, `tool_call_id`) is
 * snake-cased for OpenAI wire compatibility. The PARAM surface stays camelCase
 * because that is what every other param on this entry is, and the mapping
 * happens here, once. Getting this backwards does not error — an unknown field
 * is simply ignored — so it is pinned by the exact-key-set test.
 */
function buildChatCompletionInput(params: ChatCompletionStepParams): ChatCompletionInputWithTools {
  return {
    model: params.model,
    messages: params.messages,
    maxTokens: params.maxTokens,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.tools !== undefined ? { tools: params.tools } : {}),
    ...(params.toolChoice !== undefined ? { tool_choice: params.toolChoice } : {}),
  };
}

/**
 * One assistant message, as this entry READS it.
 *
 * 🔴 `role` IS DELIBERATELY ABSENT, and that is a measured decision rather than
 * an omission. `AssistantMessage` in `@civitai/client` declares `role: 'assistant'`
 * as REQUIRED, but the real orchestrator response carries **only `content`** on
 * `choices[].message` — no `role` at all. An extractor that keyed off `role`
 * would return nothing for every real reply: the step would charge 1 Buzz, reach
 * `succeeded`, scan nothing and publish nothing. `./type-contract` pins both
 * halves of this — that the generated step satisfies the shape, and that a
 * message with no `role` still satisfies it.
 *
 * `content` is `null | string` and `refusal` may be set instead (a model refusal
 * is free text the model generated, so it is scanned and published on the same
 * terms as any other reply).
 */
export type ChatCompletionMessageOutputLike = {
  content?: string | null;
  refusal?: string | null;
  /**
   * Tool calls the model requested. Present when `finishReason` is
   * `'tool_calls'`, in which case `content` is typically absent entirely — the
   * measured shape of a real tool-calling reply.
   */
  tool_calls?: readonly (ChatCompletionToolCallOutputLike | null)[] | null;
};

/** One tool call on an assistant message, as this entry reads it. */
export type ChatCompletionToolCallOutputLike = {
  id?: string | null;
  type?: string | null;
  function?: { name?: string | null; arguments?: string | null } | null;
};

/**
 * A tool call as PUBLISHED to a block, once the scan has released it.
 *
 * Deliberately a narrow, fully-populated shape rather than the orchestrator's
 * optional-everything read shape: a block should not have to defend against a
 * half-formed tool call, and `extractToolCalls` drops anything that does not
 * fill it.
 */
export type BlockToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/** One completion choice, as this entry reads it. */
export type ChatCompletionChoiceOutputLike = {
  message?: ChatCompletionMessageOutputLike | null;
};

/**
 * The orchestrator's completed-step shape for `chatCompletion`.
 *
 * 🔴 EXPORTED SO IT CAN BE ANCHORED TO THE GENERATED CONTRACT. `extractText`
 * takes `unknown` and reaches this shape through a cast, so nothing at the call
 * site links it to the orchestrator's own types. `type-contract.ts` asserts that
 * a real `ChatCompletionStep` satisfies it and that every key it reads exists on
 * the generated `ChatCompletionOutput` / `ChatCompletionChoice` /
 * `AssistantMessage` — which moves the anchor off the author and onto a type
 * Civitai does not hand-write. Clause 8a's own docstring says the first
 * `'textOutput'` entry owes exactly this, because that clause is a
 * self-consistent pair (extractor + sample, same author, same file) and cannot
 * catch a pair that agrees with itself while both are wrong.
 */
export type ChatCompletionOutputStepLike = {
  output?: {
    choices?: readonly (ChatCompletionChoiceOutputLike | null)[] | null;
  } | null;
};

/**
 * The canonical encoding of "this tool call takes no arguments".
 *
 * A provider that emits `''` (or whitespace) for a zero-parameter function is
 * emitting something no consumer can use: `JSON.parse('')` THROWS, while
 * `JSON.parse('{}')` is the empty argument object the call actually means.
 * Normalising here is a repair, not a distortion of the provider's value.
 */
const EMPTY_TOOL_ARGUMENTS = '{}';

/**
 * THE ONE PREDICATE that decides which tool calls this entry publishes, and
 * with what `arguments` — used by BOTH `extractText` and `extractToolCalls`.
 *
 * 🔴 IT IS SHARED BECAUSE TWO COPIES DRIFTED, TWICE, AND EACH DRIFT WAS A BUG.
 * The extractors used to apply their own predicates, and audit found both
 * failure directions this produces:
 *
 *   - `extractText` required `args.trim().length > 0` while `extractToolCalls`
 *     accepted any string, so a call with `arguments: ''` was PUBLISHED but
 *     never SCANNED — the containment property clause 8b and three docstrings
 *     assert was literally false on shipped code.
 *   - Aligning them by making `extractToolCalls` drop the call instead made a
 *     no-argument tool call VANISH: measured end to end, a response whose only
 *     choice was a tool call with `arguments: ''` produced a snapshot carrying
 *     neither `textOutputs` nor `toolCalls` nor `textOutputWithheld`. The step
 *     was charged, reported `succeeded`, and published nothing the app author
 *     could diagnose.
 *   - The same shape on the ID axis: a provider id outside `TOOL_NAME_PATTERN`
 *     made `extractToolCalls` drop the whole call while `extractText` still
 *     published its arguments, so a block received argument JSON in
 *     `textOutputs`, an empty `toolCalls`, and no id to answer with.
 *
 * All three are the same defect — a rule open-coded at two sites is wrong at
 * one of them — so the rule now has one home. Containment holds BY
 * CONSTRUCTION: `extractText` publishes exactly the `arguments` of the calls
 * this returns, so no divergence is expressible without editing this function.
 *
 * 🔴 WHAT THAT DOES TO CLAUSE 8b, STATED PLAINLY RATHER THAN QUIETLY. While
 * BOTH extractors go through this function, they agree by construction, so 8b
 * cannot fail for a divergence reason FOR THIS ENTRY — it is a re-split
 * tripwire here, not a live divergence detector. That is a real reduction and
 * it is the deliberate trade: a structural guarantee beats a checked one.
 *
 * 🔴 SCOPE THAT CLAIM TO THIS ENTRY. 8b remains a working divergence detector
 * for any entry that open-codes two predicates — the `makeToolCallStep`
 * fixtures in `__tests__/step-text-output-moderation.test.ts` are exactly that
 * shape and 8b is live for them. The sentence is about `chat-completion`, not
 * about the clause.
 *
 * 🔴 AND BE EXACT ABOUT WHAT THE TRIPWIRE IS TESTED AGAINST, BECAUSE AN EARLIER
 * REVISION OF THIS PARAGRAPH WAS NOT. It claimed 8b "fires the moment anyone
 * re-splits these predicates" and that the claim was "mutation-tested". The
 * mutation actually run was the DELETION of `extractText`'s tool-arguments loop
 * — and audit then executed two genuine re-splits that 8b did NOT catch:
 * restoring `extractText`'s pre-consolidation `trim().length > 0` predicate,
 * and re-splitting `extractToolCalls` widened on the id axis. Both loaded
 * clean, because the canonical sample contained only well-formed calls. The
 * description was wider than the implementation — the same defect class as the
 * vacuous-loop finding before it, one level up.
 *
 * What is true NOW, and is what was mutation-tested: `canonicalOutputFor`
 * carries a choice for each divergence class this file has shipped (empty
 * `arguments`; an out-of-charset `id`), so all three mutants — the deletion and
 * both re-splits — fire 8b at registry load with its own error. A re-split on
 * an axis the sample does NOT cover would still pass; see that function's
 * docstring for the rule about adding a choice when you add a drop reason.
 */
function publishableToolCalls(
  message: { tool_calls?: readonly (ChatCompletionToolCallOutputLike | null)[] | null } | null
): BlockToolCall[] {
  const toolCalls = message?.tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  const calls: BlockToolCall[] = [];
  for (const call of toolCalls) {
    const id = call?.id;
    const name = call?.function?.name;
    const args = call?.function?.arguments;
    // 🔴 A REJECTED CALL CONTRIBUTES NOTHING ON EITHER SIDE — no published
    // call AND no orphan argument string. That pairing is the point.
    if (typeof id !== 'string' || !TOOL_NAME_PATTERN.test(id)) continue;
    if (id.length > MAX_TOOL_NAME_CHARS) continue;
    if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) continue;
    if (name.length > MAX_TOOL_NAME_CHARS) continue;
    if (typeof args !== 'string') continue;
    const normalised = args.trim().length === 0 ? EMPTY_TOOL_ARGUMENTS : args;
    calls.push({ id, type: 'function', function: { name, arguments: normalised } });
  }
  return calls;
}

export const chatCompletionStep = {
  id: 'chat-completion',
  orchestratorType: 'chatCompletion',
  billingMode: 'prepaidFixed',
  // The free-text OUTPUT posture. Scanned at the read boundary by
  // `./moderation`'s output phase, withheld on a policy hit and on the five
  // failure modes enumerated in the header's WHAT ACTUALLY WITHHOLDS section —
  // NOT on "any scanner failure"; a per-label `error` currently RELEASES.
  moderationPosture: 'textOutput',
  // `ChatCompletionInput.model` is a plain provider id, never an AIR URN, so
  // there is no way to reach a gated / early-access / Private model version
  // through this step. ENFORCED, not just declared: clause 7 deep-scans the
  // BUILT step for an AIR reference.
  resourcePolicy: { kind: 'none' },
  paramSchema: chatCompletionParamsSchema,
  // Models AS variants: the allowlist, the price key and the audit row's
  // `detail.variant` in one declaration.
  variants: CHAT_COMPLETION_MODELS,
  resolveVariant: (params: ChatCompletionStepParams): string => params.model,
  canonicalParamsFor: (variant: string): ChatCompletionStepParams => ({
    // The `as` is checked, not assumed: clause 3 safeParses these params against
    // the `z.enum` above, so a `variants` entry that is not a real model fails at
    // registry LOAD rather than producing an unparseable canonical object.
    model: variant as ChatCompletionModel,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 256,
  }),
  priceForVariant: () => CHAT_COMPLETION_PRICE_BUZZ,
  estimateBuzz: () => CHAT_COMPLETION_PRICE_BUZZ,
  buildStep: (params: ChatCompletionStepParams): OrchestratorStepTemplate => ({
    $type: 'chatCompletion',
    input: { ...buildChatCompletionInput(params) },
  }),
  /**
   * The generated free text, handed to the output scan AND published verbatim on
   * release — the read path emits exactly these strings and never `step.output`.
   * So anything this does not return is never scanned AND never published; the
   * two move together by construction.
   *
   * 🔴 IT NOW READS `message.tool_calls[]`, AND THE OLD REASON FOR SKIPPING THEM
   * IS GONE. This docstring used to say `images[]` and `tool_calls[]` were "safe
   * in the same direction" because "this entry never sets `modalities` and never
   * exposes `tools`", with the fallback that either "would be DROPPED rather
   * than published". Exposing `tools` falsified the precondition, and DROPPING
   * is precisely what a tool-calling capability cannot do — a dropped tool call
   * is a step that charges, succeeds, and publishes nothing, which is the exact
   * inert-capability failure clause 8a exists to catch.
   *
   * So the model-generated ARGUMENT STRINGS are returned here, which puts them
   * through the same scan as any other generated text. That is not incidental:
   * an argument string is free text the model wrote, on its way both to a tool
   * and to the block's own UI, and it is the surface the posture would otherwise
   * not cover.
   *
   * 🔴 AND RETURNING THEM HERE MEANS THEY ARE ALSO PUBLISHED, WHICH IS
   * DELIBERATE. This field's contract is that whatever it returns is what the
   * scan sees AND what a release publishes — "the two move together by
   * construction". Scanning the arguments while withholding them from
   * `textOutputs` would break that in the direction that reads as coverage, so
   * they appear in both. The structured `extractToolCalls` surface below is the
   * ergonomic form; this is the scanned-and-published form, and they are gated
   * on the same verdict.
   *
   * `images[]` is still not read, and is still safe for the original reason:
   * this entry never sets `modalities`, so it cannot appear, and a
   * `'textOutput'` entry has no `extractOutput` to carry it if it somehow did.
   */
  extractText: (step: unknown): string[] => {
    const choices = (step as ChatCompletionOutputStepLike | null | undefined)?.output?.choices;
    if (!Array.isArray(choices)) return [];
    const texts: string[] = [];
    for (const choice of choices) {
      const message = choice?.message;
      if (message === null || message === undefined) continue;
      // `content` may be null; `refusal` is set instead when the model declines.
      // Both are model-generated free text and both are scanned.
      for (const value of [message.content, message.refusal]) {
        // Empty and whitespace-only pieces are dropped rather than handed to the
        // scan: clause 8a rejects them, and there is nothing in them to scan or
        // to publish.
        if (typeof value === 'string' && value.trim().length > 0) texts.push(value);
      }
      // Model-generated tool ARGUMENTS, for exactly the calls this entry will
      // publish — see `publishableToolCalls`, which both extractors share so a
      // dropped call cannot leave its arguments behind and a published call
      // cannot escape the scan. The tool NAME is not included; see the
      // unscanned-set note on `extractToolCalls`.
      for (const call of publishableToolCalls(message)) texts.push(call.function.arguments);
    }
    return texts;
  },
  /**
   * The STRUCTURED tool calls, published to the block only when the scan
   * RELEASES.
   *
   * 🔴 THIS IS NOT A SECOND CHANNEL AROUND THE SCAN, AND THE DISTINCTION IS THE
   * whole reason the field is shaped this way. `attachModeratedStepTextOutputs`
   * is the sole producer of `snapshot.toolCalls` exactly as it is of
   * `snapshot.textOutputs`: it calls this only after `extractText`'s strings —
   * which INCLUDE every `arguments` value this returns — have been through
   * `screenGeneratedText` and released. A withheld verdict publishes neither.
   * A `toolCalls` field populated anywhere else would be the
   * `StepOutputMedia.url` smuggle in a new field name.
   *
   * 🔴 IT DROPS, RATHER THAN PUBLISHES, A MALFORMED CALL — including one whose
   * NAME or ID does not match `TOOL_NAME_PATTERN`. Those two are the strings
   * here that do NOT go through the scan.
   *
   * 🔴 THE ARGUMENT FOR LEAVING THEM UNSCANNED IS **NOT** THE SAME FOR BOTH,
   * and an earlier revision of this docstring claimed it was. State the real
   * asymmetry, because the weaker of the two is the one worth watching:
   *
   *   - `name` rests on TWO legs. It is echoed back from what the CALLER ITSELF
   *     declared in `tools[]`, and the input schema enforces
   *     `TOOL_NAME_PATTERN` on that declaration — so a name is both
   *     caller-authored and charset-bounded before it is ever echoed.
   *   - `id` rests on ONE leg. It is PROVIDER-generated: nothing on this side
   *     authored it, and the only thing bounding it is the pattern test below.
   *
   * 🔴 AND THAT SURVIVING LEG IS WEAKER THAN "cannot carry prose" — do not
   * re-assert that. `[a-zA-Z0-9_-]{1,64}` carries perfectly readable prose in
   * snake_case; measured, a 63-char underscore-joined sentence passes this
   * filter and is published verbatim. What the pattern actually buys is a hard
   * BOUND on length and alphabet — no markup, no urls, no AIR literals, no
   * whitespace, and 64 chars — which is what makes the residue small enough to
   * accept, not an inability to say anything.
   *
   * 🔴 THE ID BOUND IS NOT SYMMETRY-FOR-ITS-OWN-SAKE — IT CLOSES A ZERO-SCAN
   * PUBLISH PATH. Until it existed, `id` was accepted on `typeof id === 'string'
   * && length > 0` alone while the INPUT schema capped it at
   * `MAX_TOOL_NAME_CHARS`. Measured: a 5,000-char `id` carrying prose and a
   * literal `urn:air:` was published to the block verbatim — and because that
   * response's `extractText` returns `[]`, `screenGeneratedText` short-circuits
   * on the empty text set and releases WITHOUT EVER CALLING THE SCANNER. So the
   * unbounded field was not merely unscanned, it was on a path where no scan
   * ran at all. Neither clause 8b (which compares `arguments` only) nor the
   * runtime shape guard in `./moderation` (which checks types, not bounds)
   * would catch a regression here; this line is the whole control.
   *
   * 🔴 AND THE DOCSTRING THIS REPLACES ASSERTED THE NAME WAS "the one string
   * here that does not go through the scan", WHICH WAS FALSE — `id` did not
   * either. The unscanned published set is exactly `{ name, id }`, and it is
   * enumerated here so the next person widening this surface has to count.
   *
   * 🔴 EMPTY / WHITESPACE-ONLY `arguments` ARE NORMALISED TO `'{}'`, NOT
   * DROPPED — and the intermediate revision that dropped them was a REGRESSION
   * this file shipped and audit caught. Measured end to end: a response whose
   * only choice was a tool call with `arguments: ''` produced a snapshot with
   * neither `textOutputs` nor `toolCalls` nor `textOutputWithheld`, i.e. a step
   * that was CHARGED, reported `succeeded`, and published literally nothing the
   * app author could diagnose. A no-argument call (`list_categories`) is an
   * ordinary case, not a malformed one.
   *
   * Normalising loosens NOTHING, and that is the point clause 8b turns on: it
   * compares published `arguments` against the SCANNED set, and a whitespace-
   * only string carries nothing a scanner could read. `'{}'` is also the only
   * value a consumer can use — `JSON.parse('')` throws. The ordinary encoding
   * `'{}'` is unaffected either way.
   */
  extractToolCalls: (step: unknown): BlockToolCall[] => {
    const choices = (step as ChatCompletionOutputStepLike | null | undefined)?.output?.choices;
    if (!Array.isArray(choices)) return [];
    const calls: BlockToolCall[] = [];
    for (const choice of choices) {
      // The SHARED predicate — see `publishableToolCalls`. `extractText`
      // publishes exactly these calls' `arguments`, so containment holds by
      // construction rather than by two predicates staying in step.
      calls.push(...publishableToolCalls(choice?.message ?? null));
    }
    return calls;
  },
  /**
   * A canonical COMPLETED step, for the load-time extraction probes (clauses 8a
   * and 8b).
   *
   * 🔴 THE SAMPLE IS TWO CAPTURED CHOICES PLUS TWO ADVERSARIAL ONES, AND THE
   * SPLIT IS STATED BECAUSE AN EARLIER REVISION CLAIMED ALL OF THEM WERE
   * CAPTURED. That was true when there were two; it became false the moment
   * choices 2 and 3 were added to arm clause 8b, and a stale "verbatim" banner
   * over invented data is worse than no banner — it tells the next reader the
   * probe has a property it does not have.
   *
   *   - Choices 0 and 1 are COPIED VERBATIM from real orchestrator responses.
   *     They are what keeps the both-wrong-blind hazard closed: a sample
   *     written FROM the extractor would make the probe assert only that the
   *     code agrees with itself, which clause 8a's own docstring names as the
   *     thing it cannot catch. Note what the first real response does NOT
   *     contain: `message` carries **only `content`** — no `role`, despite the
   *     generated `AssistantMessage` declaring it required. That absence is the
   *     reason `extractText` does not key off it.
   *   - Choices 2 and 3 are ADVERSARIAL VARIANTS: the message and tool-call
   *     SHAPE is the captured one, but the VALUES (`arguments: ''`, an `id`
   *     outside `TOOL_NAME_PATTERN`) were chosen to make clause 8b non-vacuous
   *     on the two divergence classes this file has actually shipped. They are
   *     NOT a claim that the orchestrator emits these values. Reachability is
   *     documented per choice; FREQUENCY is unmeasured, and no claim about it
   *     is made here.
   *
   * That distinction is what keeps the both-wrong-blind argument intact: the
   * hazard it names is an extractor and a sample agreeing on the wrong response
   * SHAPE, and every shape here is still a captured one. Varying VALUES inside
   * a captured shape does not reintroduce it. Do not add a choice with an
   * invented shape.
   *
   * 🔴 WHY THE SAMPLE KEEPS GROWING: EACH CHOICE ARMS CLAUSE 8b AGAINST ONE
   * DIVERGENCE CLASS, AND 8b CAN ONLY EVER SEE WHAT THIS SAMPLE CONTAINS.
   * Clause 8b asserts that every `arguments` string `extractToolCalls`
   * publishes is also returned by `extractText` — over THIS sample and nothing
   * else. The failure mode is therefore always the same: a class the sample
   * cannot express is a class 8b cannot detect, while still reading as
   * coverage. It has now been hit TWICE, which is why this list is explicit:
   *
   *   1. NO `tool_calls` AT ALL (the state when tool calling first landed) —
   *      the loop iterated an EMPTY set and passed vacuously. A real
   *      containment break in the shipped extractor (`arguments: args +
   *      'SMUGGLED'`) loaded CLEAN. Closed by choice 1.
   *   2. ONLY WELL-FORMED CALLS (the state after that fix) — the loop ran, but
   *      every value in it was conforming, so neither shipped divergence class
   *      was expressible. Measured: re-splitting `extractText` back to its
   *      pre-consolidation `trim().length > 0` predicate, and re-splitting
   *      `extractToolCalls` widened on the id axis, BOTH loaded clean. Closed
   *      by choices 2 and 3.
   *
   * 🔴 SO THE RULE FOR ANYONE EDITING `publishableToolCalls`: if you add a
   * reason a call may be dropped or rewritten, add a choice that exercises it,
   * and give it an `arguments` string DISTINCT from every other choice's. A
   * colliding string is found in the scanned set and 8b stays silent — that
   * collision is not hypothetical, it is mechanically how case 2 above hid.
   *
   * 🔴 THE MULTI-CHOICE ENVELOPE IS A COMPOSITION, AND THAT IS SAID PLAINLY. No
   * single captured response carried more than one choice, because `n` defaults
   * to 1. The composition is legitimate for what these clauses actually test —
   * that the extractor PAIR agrees with itself on real message shapes — and it
   * is what keeps the content path and every tool-call path covered at load
   * instead of trading one for another. It is NOT a claim that the orchestrator
   * emits four choices.
   */
  canonicalOutputFor: (): unknown => ({
    $type: 'chatCompletion',
    name: 'block-step',
    status: 'succeeded',
    output: {
      id: 'gen-1785782779-5cBM39ztiT9kC93qr5kf',
      object: 'chat.completion',
      created: 1785782779,
      model: 'openai/gpt-4o-mini',
      choices: [
        { index: 0, message: { content: 'OK' }, finishReason: 'stop' },
        {
          index: 1,
          finishReason: 'tool_calls',
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_d41b5525e73e4551ab588457',
                type: 'function',
                function: {
                  name: 'search_models',
                  arguments: '{"query":"DreamShaper checkpoint","limit":1}',
                },
              },
            ],
          },
        },
        // ADVERSARIAL 1 — empty `arguments`. Published (normalised to `'{}'`) by
        // BOTH extractors on unmutated code, so containment still holds. Arms 8b
        // against an `extractText` that re-applies a `trim().length > 0` filter:
        // it would then drop this string while `extractToolCalls` still
        // publishes the normalised `'{}'`, which is the divergence 8b exists for.
        {
          index: 2,
          finishReason: 'tool_calls',
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_zeroargs00000000000000',
                type: 'function',
                function: { name: 'list_categories', arguments: '' },
              },
            ],
          },
        },
        // ADVERSARIAL 2 — an `id` outside `TOOL_NAME_PATTERN` (dots), with
        // arguments DISTINCT from every other string in this sample. Dropped by
        // BOTH extractors on unmutated code, so containment still holds. Arms 8b
        // against an `extractToolCalls` re-split and widened on the id axis: it
        // would publish these arguments while `extractText` does not return
        // them. 🔴 The distinctness is load-bearing — an arguments string that
        // collided with another choice's would be found in the scanned set and
        // 8b would stay silent, which is precisely how the pre-existing sample
        // failed to arm it.
        {
          index: 3,
          finishReason: 'tool_calls',
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call.with.dots',
                type: 'function',
                function: { name: 'get_model', arguments: '{"modelId":4384}' },
              },
            ],
          },
        },
      ],
      usage: { promptTokens: 12, completionTokens: 1, totalTokens: 13 },
      systemFingerprint: 'fp_5259353f0d',
    },
  }),
} satisfies BlockStep<ChatCompletionStepParams>;
