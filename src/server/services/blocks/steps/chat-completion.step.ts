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
//  2. FLAT, MEASURED COST. A real submit was quoted and charged **1 Buzz**, and
//     that held across every model below AND across `maxTokens` 1 → 200,000 — so
//     the price is knowable before execution → `prepaidFixed`. See
//     `CHAT_COMPLETION_PRICE_BUZZ`.
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
// `buildStep` emits exactly `{ model, messages, maxTokens, temperature? }`
// (pinned by the exact-key-set test in `__tests__/chat-completion.step.test.ts`).
// `model` is `z.enum`-bounded to `CHAT_COMPLETION_MODELS`, `maxTokens` and
// `temperature` are numbers, every key is a fixed literal, and `role` is a
// three-value enum. So **`messages[].content` is the only string in the built
// input that an untrusted iframe can put arbitrary text into** — and it is
// human prose, forwarded from whatever an end user typed into a chat block.
// This entry is the FIRST whose scanned strings are prose; every earlier one
// (`convert-image`) scanned urls the APP constructs. For this entry the guard
// therefore reduces exactly to: reject any chat message containing the literal
// `urn:air:`. A user asking "what does urn:air: mean?" gets a hard FORBIDDEN.
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
 * The declared exact price, in Buzz.
 *
 * MEASURED, not declared: real submits against the live orchestrator returned
 * `cost.total = 1` for every model in `CHAT_COMPLETION_MODELS` and for
 * `maxTokens` from 1 to 200,000. `estimateBuzz` returns this same constant —
 * the registry's load-time invariant forces the two to agree, because the block
 * is SHOWN the estimate and CHARGED the price.
 *
 * 🔴 It is NOT the enforced ceiling. The step submit path runs its own `whatif`
 * before the per-call `buzzBudget` gate and reserves `max(declared, quoted)`, so
 * a rate-card change is caught at submit rather than by a human reading a
 * counter later. See the ORCHESTRATOR QUOTE section in `blocks.router.ts`.
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
const MAX_MESSAGE_CHARS = 8_000;

/** Sampling temperature bounds, taken from `ChatCompletionInput.temperature`'s own documented range. */
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;

/**
 * One conversation turn.
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
 * `.strict()`, so `name`, `tool_calls` and `images` are rejected rather than
 * forwarded.
 */
const chatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1).max(MAX_MESSAGE_CHARS),
  })
  .strict();

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
  .strict();

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
 * The bounded input this entry submits, ANCHORED to the generated
 * `ChatCompletionInput`.
 *
 * Declaring the return type is what makes the field NAMES load-bearing: a
 * renamed or retyped field on the orchestrator's own input contract is a build
 * failure here rather than a request the orchestrator ignores. `messages` is
 * anchored to `ChatCompletionInput`'s own `Array<ChatCompletionMessage>` (the
 * `{ role: string }` base) rather than to `UserMessage`, because that alias's
 * `content: Array<ChatCompletionContentPart>` contradicts the measured wire
 * behaviour — see `chatMessageSchema`.
 */
function buildChatCompletionInput(params: ChatCompletionStepParams): ChatCompletionInput {
  return {
    model: params.model,
    messages: params.messages,
    maxTokens: params.maxTokens,
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
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
   * 🔴 IT DOES NOT READ `message.images[]` OR `message.tool_calls[]`, and both
   * omissions are safe in the same direction. Neither can appear — this entry
   * never sets `modalities` and never exposes `tools` — and if one somehow did,
   * it would be DROPPED rather than published, because a `'textOutput'` entry has
   * no `extractOutput` to carry it. The fail-closed direction.
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
    }
    return texts;
  },
  /**
   * A canonical COMPLETED step, for the load-time extraction probe (clause 8a).
   *
   * 🔴 COPIED VERBATIM FROM A REAL ORCHESTRATOR RESPONSE, not invented to match
   * `extractText`. A sample written from the extractor would make the probe
   * assert only that the code agrees with itself — the both-wrong-blind shape
   * clause 8a's own docstring names as the thing it cannot catch. Note what the
   * real response does NOT contain: `choices[0].message` carries **only
   * `content`** — no `role`, despite the generated `AssistantMessage` declaring
   * it required. That absence is the reason `extractText` does not key off it.
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
      choices: [{ index: 0, message: { content: 'OK' }, finishReason: 'stop' }],
      usage: { promptTokens: 12, completionTokens: 1, totalTokens: 13 },
      systemFingerprint: 'fp_5259353f0d',
    },
  }),
} satisfies BlockStep<ChatCompletionStepParams>;
