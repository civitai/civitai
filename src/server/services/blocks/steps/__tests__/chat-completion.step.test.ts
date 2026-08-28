import { describe, expect, it } from 'vitest';
import {
  CHAT_COMPLETION_ASSUMED_CHARS_PER_TOKEN,
  CHAT_COMPLETION_MAX_OUTPUT_TOKENS,
  CHAT_COMPLETION_MODELS,
  CHAT_COMPLETION_PRICE_BUZZ,
  chatCompletionStep,
  MAX_TOOL_ROUNDS,
  type ChatCompletionStepParams,
} from '~/server/services/blocks/steps/chat-completion.step';
import {
  assertStepInvariants,
  containsAirReference,
  estimateStepBuzz,
  getStep,
  getStepByOrchestratorType,
  planStepSpend,
  REGISTERED_STEP_IDS,
  resolveStepVariant,
  type AnyBlockStep,
} from '~/server/services/blocks/steps';
import { MAX_SCANNED_CONTENT_CHARS } from '~/server/services/blocks/steps/text-output-moderation';

/**
 * Coverage for the `chat-completion` registry entry — the first `'textOutput'`
 * adopter.
 *
 * The registry's own population tests (`step-registry.test.ts`) already run
 * every load-time clause over every registered entry, so this file does NOT
 * repeat them. What it covers is the part of the entry no generic clause can
 * see: the model allowlist, the `maxTokens` ceiling and its derivation from the
 * scan cap, the deliberately-absent `modalities` surface, and an `extractText`
 * pinned against the REAL orchestrator response rather than against itself.
 */

const STEP_ID = 'chat-completion';

/** Params that parse. Every negative case below is this, with ONE thing broken. */
const VALID_PARAMS: ChatCompletionStepParams = {
  model: 'deepseek/deepseek-chat',
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 128,
};

/**
 * 🔴 THE REAL ORCHESTRATOR RESPONSE, captured from a live `succeeded` workflow.
 *
 * Copied here independently of `canonicalOutputFor` so that this file's
 * assertions are not simply re-reading the entry's own sample. Note what it does
 * NOT contain: `choices[0].message` carries only `content` — no `role`.
 */
const REAL_COMPLETED_STEP = {
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
};

const parse = (params: unknown) => chatCompletionStep.paramSchema.safeParse(params);
const withParam = (key: string, value: unknown) => ({ ...VALID_PARAMS, [key]: value });

describe('chat-completion — registration', () => {
  it('is registered under its own id, and the id equals step.id', () => {
    expect(REGISTERED_STEP_IDS).toContain(STEP_ID);
    expect(getStep(STEP_ID)).toBe(chatCompletionStep as unknown as AnyBlockStep);
    expect(chatCompletionStep.id).toBe(STEP_ID);
  });

  it('does not disturb the existing wire enum ordering', () => {
    // Existing tests use `REGISTERED_STEP_IDS[0]` as "a valid id"; a new entry
    // must be appended, never prepended.
    expect(REGISTERED_STEP_IDS[0]).toBe('convert-image');
  });

  it('declares the four axes the registry dispatches on', () => {
    expect(chatCompletionStep.orchestratorType).toBe('chatCompletion');
    expect(chatCompletionStep.billingMode).toBe('prepaidFixed');
    expect(chatCompletionStep.moderationPosture).toBe('textOutput');
    expect(chatCompletionStep.resourcePolicy).toEqual({ kind: 'none' });
  });

  it('is resolvable by the $type the workflow extractors see', () => {
    expect(getStepByOrchestratorType('chatCompletion')).toBe(
      chatCompletionStep as unknown as AnyBlockStep
    );
  });

  it('satisfies every load-time invariant (re-asserted for THIS entry by name)', () => {
    expect(() =>
      assertStepInvariants(STEP_ID, chatCompletionStep as unknown as AnyBlockStep)
    ).not.toThrow();
  });

  it('🔴 declares NO extractOutput — a text entry has no media channel at all', () => {
    // The anti-smuggling property: `StepOutputMedia.url` is a bare string that
    // reaches `snapshot.imageUrls` without meeting the output scan, so a text
    // entry must not have one. Clause 8-ii rejects it; this pins the entry.
    expect(
      (chatCompletionStep as unknown as { extractOutput?: unknown }).extractOutput
    ).toBeUndefined();
    expect(
      (chatCompletionStep as unknown as { auditableText?: unknown }).auditableText
    ).toBeUndefined();
  });
});

describe('chat-completion — the model allowlist', () => {
  it('exposes exactly the three v1 models, as BOTH the enum and the variants', () => {
    expect(CHAT_COMPLETION_MODELS).toEqual([
      'deepseek/deepseek-chat',
      'cognitivecomputations/dolphin-mistral-24b-venice-edition',
      'openai/gpt-4o-mini',
    ]);
    // 🔴 The two must be the same set. The enum is the parse-time bound and
    // `variants` is the money-path bound; a divergence means one of them is
    // guarding nothing.
    expect([...chatCompletionStep.variants]).toEqual([...CHAT_COMPLETION_MODELS]);
  });

  it('accepts every declared model', () => {
    for (const model of CHAT_COMPLETION_MODELS) {
      expect(parse(withParam('model', model)).success).toBe(true);
    }
  });

  it('🔴 REJECTS a model outside the allowlist — at PARSE, before the variant guard', () => {
    // The measured failure this closes: a fabricated model is quoted 1 Buzz,
    // CHARGED 1 Buzz, and then fails at execution with no output and no refund.
    const result = parse(withParam('model', 'openai/gpt-5-turbo-fictional'));
    expect(result.success).toBe(false);
  });

  it('resolves each model to itself as the bounded variant, and prices off it', () => {
    for (const model of CHAT_COMPLETION_MODELS) {
      const params = withParam('model', model);
      const step = chatCompletionStep as unknown as AnyBlockStep;
      const variant = resolveStepVariant(step, params);
      expect(variant).toBe(model);
      expect(planStepSpend(step, params, variant).reserveBuzz).toBe(CHAT_COMPLETION_PRICE_BUZZ);
    }
  });
});

describe('chat-completion — the bounded param surface', () => {
  it('accepts the valid shape', () => {
    expect(parse(VALID_PARAMS).success).toBe(true);
  });

  it('🔴 REJECTS `modalities` — the field that would return unmoderated base64 images', () => {
    // `modalities: ['image']` routes the request to the image pipeline and
    // returns images on `choices[].message.images[].image_url.url` as base64
    // data URIs, which never become moderated `Image` rows. Not exposing it is
    // what makes this entry honestly text-only.
    expect(parse(withParam('modalities', ['image'])).success).toBe(false);
    expect(parse(withParam('modalities', ['text'])).success).toBe(false);
  });

  it('🔴 REJECTS `image_config` — modalities’ companion', () => {
    expect(parse(withParam('image_config', { aspect_ratio: '1:1' })).success).toBe(false);
  });

  it('REJECTS every other orchestrator input field this entry does not expose', () => {
    // `.strict()` in action. Each of these is a real `ChatCompletionInput`
    // field; forwarding any of them from an untrusted iframe is a widening
    // nobody reviewed.
    for (const [key, value] of [
      ['tools', []],
      ['tool_choice', 'auto'],
      ['n', 4],
      ['stop', ['x']],
      ['seed', 1],
      ['topP', 0.5],
      ['presencePenalty', 1],
      ['frequencyPenalty', 1],
      ['logprobs', true],
      ['chatTemplateKwargs', {}],
      ['responseFormat', { type: 'json_object' }],
      ['user', 'someone'],
    ] as [string, unknown][]) {
      expect(parse(withParam(key, value)).success, `expected '${key}' to be rejected`).toBe(false);
    }
  });

  describe('maxTokens', () => {
    it('🔴 REJECTS an OMITTED maxTokens — an unbounded default is unbounded compute at a flat price', () => {
      const { maxTokens: _dropped, ...withoutMaxTokens } = VALID_PARAMS;
      expect(parse(withoutMaxTokens).success).toBe(false);
    });

    it('accepts the boundary values and rejects just outside them', () => {
      expect(parse(withParam('maxTokens', 1)).success).toBe(true);
      expect(parse(withParam('maxTokens', CHAT_COMPLETION_MAX_OUTPUT_TOKENS)).success).toBe(true);
      expect(parse(withParam('maxTokens', 0)).success).toBe(false);
      expect(parse(withParam('maxTokens', CHAT_COMPLETION_MAX_OUTPUT_TOKENS + 1)).success).toBe(
        false
      );
      expect(parse(withParam('maxTokens', 1.5)).success).toBe(false);
      expect(parse(withParam('maxTokens', 200_000)).success).toBe(false);
    });

    it('🔴 THE DERIVATION: the ceiling cannot produce more than the scan will accept', () => {
      // The two constants live in different modules on purpose — importing the
      // cap into the entry would drag `orchestrator.service` onto the registry's
      // module-load path. THIS is the link between them, and it goes red if
      // either number moves.
      //
      // Over the cap is a WITHHOLD, not a truncation, so a ceiling that can
      // exceed it designs a guaranteed "paid for nothing" into the capability.
      const worstCaseChars =
        CHAT_COMPLETION_MAX_OUTPUT_TOKENS * CHAT_COMPLETION_ASSUMED_CHARS_PER_TOKEN;
      expect(worstCaseChars).toBeLessThan(MAX_SCANNED_CONTENT_CHARS);
      // And with real headroom, not by one character: the nominal ~4 chars/token
      // is an average, and whitespace/repetition merges push the real ratio up.
      expect(worstCaseChars * 3).toBeLessThanOrEqual(MAX_SCANNED_CONTENT_CHARS);
      // The literals, pinned. A test that only compares the two constants to
      // each other passes if BOTH are changed together, which is exactly the
      // change that needs a human to look at it.
      expect(CHAT_COMPLETION_MAX_OUTPUT_TOKENS).toBe(4_000);
      expect(CHAT_COMPLETION_ASSUMED_CHARS_PER_TOKEN).toBe(4);
      expect(MAX_SCANNED_CONTENT_CHARS).toBe(50_000);
    });
  });

  describe('messages', () => {
    it('requires at least one message', () => {
      expect(parse(withParam('messages', [])).success).toBe(false);
    });

    it('accepts the three roles and rejects any other', () => {
      for (const role of ['system', 'user', 'assistant']) {
        expect(parse(withParam('messages', [{ role, content: 'x' }])).success).toBe(true);
      }
      expect(parse(withParam('messages', [{ role: 'tool', content: 'x' }])).success).toBe(false);
      expect(parse(withParam('messages', [{ role: 'developer', content: 'x' }])).success).toBe(
        false
      );
    });

    it('🔴 REJECTS a content-part ARRAY — the shape that carries an orchestrator-fetched imageUrl', () => {
      // `ChatCompletionContentPart` has an `imageUrl` the orchestrator FETCHES.
      // Accepting the array form would put an arbitrary remote URL on the wire
      // from an untrusted iframe — the SSRF primitive `convert-image` bounds
      // with `civitaiHostedImageUrlSchema`.
      const partArray = [{ type: 'imageUrl', imageUrl: { url: 'http://169.254.169.254/' } }];
      expect(parse(withParam('messages', [{ role: 'user', content: partArray }])).success).toBe(
        false
      );
    });

    it('rejects empty content, over-long content, and unknown message keys', () => {
      expect(parse(withParam('messages', [{ role: 'user', content: '' }])).success).toBe(false);
      expect(
        parse(withParam('messages', [{ role: 'user', content: 'x'.repeat(8_001) }])).success
      ).toBe(false);
      expect(
        parse(withParam('messages', [{ role: 'user', content: 'x'.repeat(8_000) }])).success
      ).toBe(true);
      expect(
        parse(withParam('messages', [{ role: 'user', content: 'x', name: 'bob' }])).success
      ).toBe(false);
      expect(
        parse(withParam('messages', [{ role: 'assistant', content: 'x', tool_calls: [] }])).success
      ).toBe(false);
    });

    it('bounds the conversation length', () => {
      const msg = { role: 'user' as const, content: 'x' };
      expect(parse(withParam('messages', Array(32).fill(msg))).success).toBe(true);
      expect(parse(withParam('messages', Array(33).fill(msg))).success).toBe(false);
    });
  });

  describe('temperature', () => {
    it('is optional and bounded to the documented 0-2 range', () => {
      expect(parse(withParam('temperature', 0)).success).toBe(true);
      expect(parse(withParam('temperature', 2)).success).toBe(true);
      expect(parse(withParam('temperature', -0.1)).success).toBe(false);
      expect(parse(withParam('temperature', 2.1)).success).toBe(false);
      expect(parse(VALID_PARAMS).success).toBe(true);
    });
  });
});

describe('chat-completion — buildStep', () => {
  it('emits the declared $type', () => {
    expect(chatCompletionStep.buildStep(VALID_PARAMS).$type).toBe('chatCompletion');
  });

  it('🔴 emits an EXACT key set — nothing may be added without failing this test', () => {
    // The guard against a future edit quietly re-introducing `modalities`,
    // `image_config`, `tools` or `n`. An allow-list assertion, not a
    // "does not contain modalities" one: the next dangerous field is the one
    // nobody thought to name here.
    expect(Object.keys(chatCompletionStep.buildStep(VALID_PARAMS)).sort()).toEqual([
      '$type',
      'input',
    ]);
    expect(Object.keys(chatCompletionStep.buildStep(VALID_PARAMS).input).sort()).toEqual([
      'maxTokens',
      'messages',
      'model',
    ]);
    expect(
      Object.keys(chatCompletionStep.buildStep({ ...VALID_PARAMS, temperature: 0.7 }).input).sort()
    ).toEqual(['maxTokens', 'messages', 'model', 'temperature']);
  });

  it('forwards the parsed params verbatim', () => {
    const built = chatCompletionStep.buildStep(VALID_PARAMS);
    expect(built.input).toEqual({
      model: 'deepseek/deepseek-chat',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 128,
    });
  });

  it('omits temperature entirely when it was not supplied (never sends undefined)', () => {
    expect('temperature' in chatCompletionStep.buildStep(VALID_PARAMS).input).toBe(false);
  });

  it('carries NO AIR reference, for every variant (clause 7, re-pinned)', () => {
    for (const variant of CHAT_COMPLETION_MODELS) {
      const built = chatCompletionStep.buildStep(chatCompletionStep.canonicalParamsFor(variant));
      expect(containsAirReference(built.input)).toBe(false);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 `messages[].content` IS THE ONLY AIR-SCANNABLE SURFACE THIS ENTRY HAS,
  // AND IT IS PROSE.
  //
  // The request-time re-assert in `blocks.router.ts` runs `containsAirReference`
  // over the WHOLE built input. This pins WHICH part of that input a caller can
  // actually steer, because that is the fact the guard's cost/benefit rests on:
  // for this entry the guard reduces to "reject a chat message containing the
  // literal `urn:air:`". The FALSE-POSITIVE SURFACE section in
  // `../chat-completion.step.ts` carries the evidence and the decision.
  //
  // 🔴 LABELLED AS AN INVARIANT GUARD, NOT REGRESSION COVERAGE — it is green
  // before and after the change that introduced it. It exists so that a future
  // edit widening the schema (a free-string `user`, a `stop` array, content
  // PARTS carrying `imageUrl`) fails here and forces the analysis to be redone,
  // rather than silently invalidating it.
  // ───────────────────────────────────────────────────────────────────────────
  it('🔴 prose in messages[].content is the ONLY caller-steerable string the AIR scan sees', () => {
    const air = 'urn:air:sdxl:checkpoint:civitai:4384@128713';

    // (a) The literal in PROSE trips the scan — a question ABOUT the scheme is
    //     enough; it does not have to be a well-formed AIR.
    expect(
      containsAirReference(
        chatCompletionStep.buildStep({
          ...VALID_PARAMS,
          messages: [{ role: 'user', content: 'what does urn:air: mean?' }],
        }).input
      )
    ).toBe(true);
    expect(
      containsAirReference(
        chatCompletionStep.buildStep({
          ...VALID_PARAMS,
          messages: [
            { role: 'system', content: 'be helpful' },
            { role: 'user', content: `is ${air} any good?` },
          ],
        }).input
      )
    ).toBe(true);

    // (b) NEGATIVE CONTROL for (a): the same prose minus the literal does NOT
    //     trip it, so (a) is about the literal and not about `messages` being
    //     scanned at all.
    expect(
      containsAirReference(
        chatCompletionStep.buildStep({
          ...VALID_PARAMS,
          messages: [{ role: 'user', content: 'what does air mean?' }],
        }).input
      )
    ).toBe(false);

    // (c) NOTHING ELSE in the built input can carry it. The keys are fixed
    //     literals, `role` is a three-value enum, and the two numeric params
    //     cannot hold a string — so every remaining field is enumerated here
    //     with a caller-chosen extreme value and none of them trips the scan.
    for (const model of CHAT_COMPLETION_MODELS) {
      expect(
        containsAirReference(
          chatCompletionStep.buildStep({
            model,
            messages: [{ role: 'assistant', content: 'ok' }],
            maxTokens: CHAT_COMPLETION_MAX_OUTPUT_TOKENS,
            temperature: 2,
          }).input
        )
      ).toBe(false);
    }

    // (d) …and `model` is the one field the ORCHESTRATOR does resolve as an AIR
    //     (`ChatCompletionHandler.CalculateCostAsync` branches on
    //     `input.Model.StartsWith("urn:air:")`). The `z.enum` is what keeps that
    //     branch unreachable, so assert no allowlisted model is an AIR — if one
    //     ever is, this entry needs a real `resourcePolicy`, not a `'none'`.
    for (const model of CHAT_COMPLETION_MODELS) {
      expect(model.toLowerCase().includes('urn:air:')).toBe(false);
    }
  });
});

describe('chat-completion — price and estimate', () => {
  it('is a flat 1 Buzz, and the estimate equals the price for every variant', () => {
    expect(CHAT_COMPLETION_PRICE_BUZZ).toBe(1);
    for (const variant of CHAT_COMPLETION_MODELS) {
      const params = chatCompletionStep.canonicalParamsFor(variant);
      expect(chatCompletionStep.priceForVariant()).toBe(CHAT_COMPLETION_PRICE_BUZZ);
      expect(chatCompletionStep.estimateBuzz()).toBe(CHAT_COMPLETION_PRICE_BUZZ);
      expect(estimateStepBuzz(chatCompletionStep as unknown as AnyBlockStep, params)).toBe(
        CHAT_COMPLETION_PRICE_BUZZ
      );
    }
  });

  it('does not vary with maxTokens — the measured flat rate, pinned', () => {
    const step = chatCompletionStep as unknown as AnyBlockStep;
    for (const maxTokens of [1, 128, CHAT_COMPLETION_MAX_OUTPUT_TOKENS]) {
      expect(estimateStepBuzz(step, withParam('maxTokens', maxTokens))).toBe(
        CHAT_COMPLETION_PRICE_BUZZ
      );
    }
  });
});

describe('chat-completion — extractText, against the REAL response', () => {
  it('🔴 returns the assistant content from the captured live response', () => {
    expect(chatCompletionStep.extractText(REAL_COMPLETED_STEP)).toEqual(['OK']);
  });

  it('🔴 does NOT depend on `role` — the real response has none, the generated type requires one', () => {
    // If the extractor keyed off `role`, this returns [] and the capability is
    // inert for every real reply while clause 8a stays green (the entry's own
    // sample would just have been written WITH a role).
    const withRole = {
      output: { choices: [{ message: { role: 'assistant', content: 'with role' } }] },
    };
    const withoutRole = { output: { choices: [{ message: { content: 'without role' } }] } };
    expect(chatCompletionStep.extractText(withRole)).toEqual(['with role']);
    expect(chatCompletionStep.extractText(withoutRole)).toEqual(['without role']);
  });

  it('returns a `refusal` — model-generated free text is scanned on the same terms', () => {
    const refused = {
      output: { choices: [{ message: { content: null, refusal: 'I cannot help with that.' } }] },
    };
    expect(chatCompletionStep.extractText(refused)).toEqual(['I cannot help with that.']);
  });

  it('returns BOTH content and refusal when both are present', () => {
    const both = { output: { choices: [{ message: { content: 'a', refusal: 'b' } }] } };
    expect(chatCompletionStep.extractText(both)).toEqual(['a', 'b']);
  });

  it('returns every choice, in order', () => {
    const multi = {
      output: { choices: [{ message: { content: 'one' } }, { message: { content: 'two' } }] },
    };
    expect(chatCompletionStep.extractText(multi)).toEqual(['one', 'two']);
  });

  it('drops null, empty and whitespace-only pieces (clause 8a rejects them)', () => {
    const noisy = {
      output: {
        choices: [
          { message: { content: null } },
          { message: { content: '' } },
          { message: { content: '   \n\t ' } },
          { message: { content: 'real' } },
        ],
      },
    };
    expect(chatCompletionStep.extractText(noisy)).toEqual(['real']);
  });

  it('🔴 does NOT read `message.images[]` — base64 image data URIs are never published as text', () => {
    // They cannot appear (this entry never sets `modalities`), and if they did
    // they would be DROPPED, not published: a text entry has no `extractOutput`.
    const withImages = {
      output: {
        choices: [
          {
            message: {
              content: 'here you go',
              images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
            },
          },
        ],
      },
    };
    expect(chatCompletionStep.extractText(withImages)).toEqual(['here you go']);
  });

  it('🔴 DOES read `tool_calls[].function.arguments` — model-written text must be scanned', () => {
    // 🔴 THIS ASSERTION IS INVERTED FROM WHAT IT USED TO BE, DELIBERATELY. It
    // previously pinned `extractText` NOT reading tool calls, which was correct
    // while the entry could not expose `tools` at all: the only safe thing to do
    // with a field that could never legitimately appear was drop it.
    //
    // Exposing `tools` falsified that premise. An `arguments` string is free
    // text the MODEL wrote, on its way to a tool and to the block's UI, so
    // dropping it would mean either publishing it unscanned through the
    // structured surface, or shipping a capability that charges and returns
    // nothing. Both are worse than scanning it.
    const withTools = {
      output: {
        choices: [
          {
            message: {
              content: 'calling',
              tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{}' } }],
            },
          },
        ],
      },
    };
    expect(chatCompletionStep.extractText(withTools)).toEqual(['calling', '{}']);
  });

  it('is total over absent, null and malformed input', () => {
    expect(chatCompletionStep.extractText(undefined)).toEqual([]);
    expect(chatCompletionStep.extractText(null)).toEqual([]);
    expect(chatCompletionStep.extractText({})).toEqual([]);
    expect(chatCompletionStep.extractText({ output: null })).toEqual([]);
    expect(chatCompletionStep.extractText({ output: {} })).toEqual([]);
    expect(chatCompletionStep.extractText({ output: { choices: null } })).toEqual([]);
    expect(chatCompletionStep.extractText({ output: { choices: 'nope' } })).toEqual([]);
    expect(chatCompletionStep.extractText({ output: { choices: [null] } })).toEqual([]);
    expect(chatCompletionStep.extractText({ output: { choices: [{}] } })).toEqual([]);
    expect(chatCompletionStep.extractText({ output: { choices: [{ message: null }] } })).toEqual(
      []
    );
    expect(
      chatCompletionStep.extractText({ output: { choices: [{ message: { content: 42 } }] } })
    ).toEqual([]);
  });

  it('🔴 the entry’s own canonical sample is the SAME real response, for every variant', () => {
    // Clause 8a probes `extractText(canonicalOutputFor(v))`. This asserts the
    // sample was not quietly re-written to suit the extractor: it must still
    // equal the captured response held independently at the top of this file.
    for (const variant of CHAT_COMPLETION_MODELS) {
      expect(chatCompletionStep.canonicalOutputFor(variant)).toEqual(REAL_COMPLETED_STEP);
      expect(
        chatCompletionStep.extractText(chatCompletionStep.canonicalOutputFor(variant))
      ).toEqual(['OK']);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TOOL CALLING — the `tools` / `toolChoice` param surface, the round bound, and
// the tool-call read path.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A REAL tool-calling response, captured verbatim from a live orchestrator
 * submit (`deepseek/deepseek-chat`, one `search_models` function,
 * `toolChoice: "required"`, status `succeeded`).
 *
 * 🔴 CAPTURED, NOT INVENTED, for exactly the reason the entry's own
 * `canonicalOutputFor` docstring gives: a fixture written FROM the extractor
 * asserts only that the code agrees with itself. Note the two things a
 * hand-written sample would almost certainly have got wrong — `message` carries
 * NO `content` key at all (not `content: null`), and `finishReason` is
 * `'tool_calls'` rather than `'stop'`.
 */
const REAL_TOOL_CALL_STEP = {
  $type: 'chatCompletion',
  name: 'block-step',
  status: 'succeeded',
  output: {
    choices: [
      {
        index: 0,
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
    ],
    usage: { promptTokens: 407, completionTokens: 27, totalTokens: 434 },
  },
};

/** A minimal well-formed tool definition. */
const VALID_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_models',
    description: 'Search the model catalog',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
};

describe('chat-completion — tools / toolChoice param surface', () => {
  it('accepts a well-formed tools payload', () => {
    const result = parse({ ...VALID_PARAMS, tools: [VALID_TOOL] });
    expect(result.success).toBe(true);
  });

  it('accepts each documented toolChoice string mode', () => {
    for (const toolChoice of ['auto', 'none', 'required'] as const) {
      expect(parse({ ...VALID_PARAMS, tools: [VALID_TOOL], toolChoice }).success).toBe(true);
    }
  });

  it('accepts a toolChoice naming a DECLARED function', () => {
    const result = parse({
      ...VALID_PARAMS,
      tools: [VALID_TOOL],
      toolChoice: { type: 'function', function: { name: 'search_models' } },
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS a toolChoice naming a function that is not in tools', () => {
    const result = parse({
      ...VALID_PARAMS,
      tools: [VALID_TOOL],
      toolChoice: { type: 'function', function: { name: 'not_declared' } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('not in tools');
  });

  it('REJECTS toolChoice with no tools — a no-op the caller would misread', () => {
    const result = parse({ ...VALID_PARAMS, toolChoice: 'required' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('requires tools');
  });

  it('REJECTS a bad toolChoice value', () => {
    expect(parse({ ...VALID_PARAMS, tools: [VALID_TOOL], toolChoice: 'maybe' }).success).toBe(
      false
    );
  });

  it('REJECTS more than the maximum tool count', () => {
    const tools = Array.from({ length: 9 }, (_, i) => ({
      ...VALID_TOOL,
      function: { ...VALID_TOOL.function, name: `tool_${i}` },
    }));
    expect(parse({ ...VALID_PARAMS, tools }).success).toBe(false);
    // …and the boundary below it is accepted, so the rejection is the COUNT and
    // not something else about the fixture.
    expect(parse({ ...VALID_PARAMS, tools: tools.slice(0, 8) }).success).toBe(true);
  });

  it('REJECTS a tool name outside the safe character class', () => {
    for (const name of ['has space', 'has.dot', 'has/slash', '']) {
      const result = parse({
        ...VALID_PARAMS,
        tools: [{ ...VALID_TOOL, function: { ...VALID_TOOL.function, name } }],
      });
      expect(result.success, `name ${JSON.stringify(name)} must be rejected`).toBe(false);
    }
  });

  it('REJECTS an over-long tool description', () => {
    const result = parse({
      ...VALID_PARAMS,
      tools: [
        { ...VALID_TOOL, function: { ...VALID_TOOL.function, description: 'x'.repeat(1_025) } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('REJECTS an over-large serialized parameters object', () => {
    const result = parse({
      ...VALID_PARAMS,
      tools: [
        {
          ...VALID_TOOL,
          function: { ...VALID_TOOL.function, parameters: { type: 'object', pad: 'x'.repeat(5_000) } },
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('serialized characters');
  });

  it('REJECTS a parameters object nested deeper than the cap', () => {
    // 🔴 THE DEPTH CAP EXISTS SO THIS FAILS HERE RATHER THAN IN THE AIR SCAN.
    // `containsAirReference` recurses fail-CLOSED past its own cap, so without
    // this an over-nested schema would be rejected as "contains an AIR
    // reference" — a confidently wrong diagnostic. Asserting the MESSAGE is what
    // pins that; a bare `success === false` would pass either way.
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 12; i++) deep = { type: 'object', properties: { nested: deep } };
    const result = parse({
      ...VALID_PARAMS,
      tools: [{ ...VALID_TOOL, function: { ...VALID_TOOL.function, parameters: deep } }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('nest deeper');
  });

  it('REJECTS a non-object parameters value', () => {
    for (const parameters of ['a string', 42, ['an', 'array'], null]) {
      const result = parse({
        ...VALID_PARAMS,
        tools: [{ ...VALID_TOOL, function: { ...VALID_TOOL.function, parameters } }],
      });
      expect(result.success, `parameters ${JSON.stringify(parameters)} must be rejected`).toBe(
        false
      );
    }
  });

  it('REJECTS unknown properties on a tool (.strict)', () => {
    expect(parse({ ...VALID_PARAMS, tools: [{ ...VALID_TOOL, extra: 1 }] }).success).toBe(false);
    expect(
      parse({
        ...VALID_PARAMS,
        tools: [{ ...VALID_TOOL, function: { ...VALID_TOOL.function, strict: true } }],
      }).success
    ).toBe(false);
  });

  it('🔴 NORMALISES parameters through JSON — a toJSON-bearing instance cannot hide from the AIR scan', () => {
    // 🔴 THE MEASURED HAZARD `containsAirReference` DOCUMENTS. `Object.keys(new
    // URL(…))` is `[]`, so a structural walk sees a harmless empty object while
    // `JSON.stringify` emits the full href. superjson reconstructs a `URL`
    // across the tRPC boundary, so this is reachable input, not a hypothetical.
    //
    // Both halves are asserted, and the FIRST is the control: without it a
    // passing second half could just mean the value was dropped.
    const smuggled = new URL('https://example.test/urn:air:sd1:checkpoint:civitai:4384@128713');
    expect(containsAirReference({ parameters: smuggled })).toBe(false); // the hazard, unnormalised
    const result = parse({
      ...VALID_PARAMS,
      tools: [
        {
          ...VALID_TOOL,
          function: { ...VALID_TOOL.function, parameters: { type: 'object', href: smuggled } },
        },
      ],
    });
    expect(result.success).toBe(true);
    // After normalisation the URL is a plain string, so the scan CAN see it —
    // and the built step is therefore refused by the entitlement re-assert
    // rather than sailing through it.
    const built = chatCompletionStep.buildStep(result.data!);
    expect(containsAirReference(built.input)).toBe(true);
  });
});

describe('chat-completion — the tool ROUND bound', () => {
  const toolMessage = (i: number) => ({
    role: 'tool' as const,
    content: `result ${i}`,
    tool_call_id: `call_${i}`,
  });

  it('accepts exactly MAX_TOOL_ROUNDS tool messages', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      ...Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => toolMessage(i)),
    ];
    expect(parse({ ...VALID_PARAMS, messages }).success).toBe(true);
  });

  it('🔴 REJECTS MAX_TOOL_ROUNDS + 1 tool messages', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      ...Array.from({ length: MAX_TOOL_ROUNDS + 1 }, (_, i) => toolMessage(i)),
    ];
    const result = parse({ ...VALID_PARAMS, messages });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('too many tool rounds');
  });

  it('🔴 the bound is enforced on the ESTIMATE path too, not only on submit', () => {
    // The AC3 property: the cap must hold wherever params are parsed. Both the
    // estimate and the submit go through `parseStepParams`, which runs THIS
    // schema — so a caller cannot probe or spend past it on either surface.
    // Asserted through the registry's own accessor rather than the imported
    // const, so it reads the entry the router would resolve.
    const entry = getStep(STEP_ID) as AnyBlockStep;
    const messages = [
      { role: 'user' as const, content: 'hello' },
      ...Array.from({ length: MAX_TOOL_ROUNDS + 1 }, (_, i) => toolMessage(i)),
    ];
    expect(entry.paramSchema.safeParse({ ...VALID_PARAMS, messages }).success).toBe(false);
  });

  it('does not count assistant tool_calls turns toward the round bound', () => {
    // A round is a RESULT coming back. The assistant turn that requested it is
    // replayed history and is bounded by `MAX_MESSAGES`, not by this cap.
    const messages = [
      { role: 'user' as const, content: 'hello' },
      ...Array.from({ length: 6 }, () => ({
        role: 'assistant' as const,
        tool_calls: [
          { id: 'c', type: 'function' as const, function: { name: 'f', arguments: '{}' } },
        ],
      })),
      ...Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => toolMessage(i)),
    ];
    expect(parse({ ...VALID_PARAMS, messages }).success).toBe(true);
  });
});

describe('chat-completion — the tool/assistant message members', () => {
  it('accepts an assistant turn carrying tool_calls and no content', () => {
    const result = parse({
      ...VALID_PARAMS,
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
          ],
        },
        { role: 'tool', content: 'result', tool_call_id: 'call_1' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS an assistant turn with neither content nor tool_calls', () => {
    const result = parse({ ...VALID_PARAMS, messages: [{ role: 'assistant' }] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('content, tool_calls, or both');
  });

  it('REJECTS a tool message with no tool_call_id', () => {
    const result = parse({
      ...VALID_PARAMS,
      messages: [{ role: 'tool', content: 'result' }],
    });
    expect(result.success).toBe(false);
  });

  it('REJECTS an unknown role and unknown message properties', () => {
    expect(parse({ ...VALID_PARAMS, messages: [{ role: 'wizard', content: 'x' }] }).success).toBe(
      false
    );
    expect(
      parse({ ...VALID_PARAMS, messages: [{ role: 'user', content: 'x', name: 'n' }] }).success
    ).toBe(false);
  });

  it('still rejects `images` on a message — the modalities surface stays shut', () => {
    expect(
      parse({
        ...VALID_PARAMS,
        messages: [{ role: 'assistant', content: 'x', images: [{ type: 'image_url' }] }],
      }).success
    ).toBe(false);
  });
});

describe('chat-completion — buildStep emits the tool fields on the WIRE names', () => {
  it('omits both fields entirely when no tools are declared', () => {
    const built = chatCompletionStep.buildStep(VALID_PARAMS);
    expect(Object.keys(built.input).sort()).toEqual(['maxTokens', 'messages', 'model']);
  });

  it('🔴 emits `tool_choice`, snake-cased, NOT the camelCase param name', () => {
    // Getting this backwards does not error — an unknown field is ignored — so
    // the feature would be silently inert. That is why it is pinned by key set.
    const params = parse({ ...VALID_PARAMS, tools: [VALID_TOOL], toolChoice: 'required' });
    expect(params.success).toBe(true);
    const built = chatCompletionStep.buildStep(params.data!);
    expect(Object.keys(built.input).sort()).toEqual([
      'maxTokens',
      'messages',
      'model',
      'tool_choice',
      'tools',
    ]);
    expect((built.input as Record<string, unknown>).tool_choice).toBe('required');
    expect((built.input as Record<string, unknown>).toolChoice).toBeUndefined();
  });
});

describe('chat-completion — extractToolCalls', () => {
  it('🔴 returns the structured call from the REAL captured response', () => {
    expect(chatCompletionStep.extractToolCalls(REAL_TOOL_CALL_STEP)).toEqual([
      {
        id: 'call_d41b5525e73e4551ab588457',
        type: 'function',
        function: {
          name: 'search_models',
          arguments: '{"query":"DreamShaper checkpoint","limit":1}',
        },
      },
    ]);
  });

  it('🔴 every arguments string it returns is ALSO returned by extractText', () => {
    // The containment property clause 8b asserts at load. Without it the
    // structured surface would publish prose the scan never read.
    const calls = chatCompletionStep.extractToolCalls(REAL_TOOL_CALL_STEP);
    const texts = chatCompletionStep.extractText(REAL_TOOL_CALL_STEP);
    for (const call of calls) expect(texts).toContain(call.function.arguments);
  });

  it('DROPS a call whose name escapes the safe character class', () => {
    // The name is the one published string the scan does not read; the pattern
    // is the entire reason that is defensible, so it is enforced on the way OUT
    // and not merely on the way in.
    const evil = {
      output: {
        choices: [
          {
            message: {
              tool_calls: [
                { id: '1', type: 'function', function: { name: 'a b c', arguments: '{}' } },
                { id: '2', type: 'function', function: { name: 'ok_name', arguments: '{}' } },
              ],
            },
          },
        ],
      },
    };
    expect(chatCompletionStep.extractToolCalls(evil).map((c) => c.function.name)).toEqual([
      'ok_name',
    ]);
  });

  it('DROPS partial calls rather than publishing a half-formed one', () => {
    const partial = {
      output: {
        choices: [
          {
            message: {
              tool_calls: [
                { type: 'function', function: { name: 'f', arguments: '{}' } }, // no id
                { id: '2', type: 'function', function: { name: 'f' } }, // no arguments
                { id: '3', type: 'function' }, // no function
                null,
              ],
            },
          },
        ],
      },
    };
    expect(chatCompletionStep.extractToolCalls(partial)).toEqual([]);
  });

  it('is total over absent, null and malformed input', () => {
    expect(chatCompletionStep.extractToolCalls(undefined)).toEqual([]);
    expect(chatCompletionStep.extractToolCalls(null)).toEqual([]);
    expect(chatCompletionStep.extractToolCalls({})).toEqual([]);
    expect(chatCompletionStep.extractToolCalls({ output: { choices: 'nope' } })).toEqual([]);
    expect(chatCompletionStep.extractToolCalls({ output: { choices: [null] } })).toEqual([]);
    expect(
      chatCompletionStep.extractToolCalls({ output: { choices: [{ message: { tool_calls: 'x' } }] } })
    ).toEqual([]);
  });

  it('returns nothing for an ordinary reply that called no tool', () => {
    expect(chatCompletionStep.extractToolCalls(REAL_COMPLETED_STEP)).toEqual([]);
  });
});
