import type { PromptEnhancementStepTemplate } from '@civitai/client';
import type { PromptEnhancementSchema } from '~/server/schema/orchestrator/promptEnhancement.schema';
import { MAX_PROMPT_LENGTH } from '~/shared/data-graph/generation/common';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { getWorkflowCallbacks } from '~/server/orchestrator/orchestrator.utils';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';

const PROMPT_ENHANCEMENT_STEP_NAME = 'prompt-enhancement';

/**
 * Build a `promptEnhancement` step suitable for inclusion in a workflow.
 * Use this in any handler that wants to chain prompt enhancement before a
 * generation step — the step's `output.enhancedPrompt` can then be referenced
 * by the downstream step via `{ $ref: '$N', path: 'output.enhancedPrompt' }`.
 *
 * Pass `suppressOutput: true` to keep the enhancement off user-visible
 * results (typical when the enhancement is an intermediate step).
 */
export function createPromptEnhancementStep(
  input: PromptEnhancementSchema,
  options?: { name?: string; suppressOutput?: boolean }
): PromptEnhancementStepTemplate {
  const instruction = buildInstruction(input);
  return {
    $type: 'promptEnhancement',
    name: options?.name,
    input: {
      ecosystem: input.ecosystem,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt ?? undefined,
      temperature: input.temperature ?? undefined,
      instruction: instruction || undefined,
      images: input.images?.length ? input.images : undefined,
    },
    metadata: options?.suppressOutput ? { suppressOutput: true } : undefined,
  };
}

/**
 * Like {@link createPromptEnhancementStep}, but also returns ready-to-wire
 * `$ref` objects for the enhanced prompt + negative prompt outputs. Use this
 * when chaining enhancement before a generation step so the downstream step
 * can read `output.enhancedPrompt` / `output.enhancedNegativePrompt` without
 * the caller having to compute the `$N` index or cast the refs to `string`.
 *
 * @example
 * const { step, prompt: promptRef, negativePrompt: negativePromptRef } =
 *   createChainedPromptEnhancementStep(input, { stepIndex: steps.length });
 * steps.push(step);
 * // pass promptRef / negativePromptRef into the next step's input
 */
export function createChainedPromptEnhancementStep(
  input: PromptEnhancementSchema,
  options: { stepIndex: number; name?: string; suppressOutput?: boolean }
): {
  step: PromptEnhancementStepTemplate;
  /** $ref to `output.enhancedPrompt`, typed as string for direct use in step inputs. */
  prompt: string;
  /** $ref to `output.enhancedNegativePrompt`, typed as string for direct use in step inputs. */
  negativePrompt: string;
} {
  const step = createPromptEnhancementStep(input, {
    name: options.name,
    suppressOutput: options.suppressOutput,
  });
  const ref = `$${options.stepIndex}`;
  return {
    step,
    prompt: { $ref: ref, path: 'output.enhancedPrompt' } as unknown as string,
    negativePrompt: { $ref: ref, path: 'output.enhancedNegativePrompt' } as unknown as string,
  };
}

export function buildInstruction(input: Omit<PromptEnhancementSchema, 'ecosystem'>): string {
  const parts: string[] = [];
  const promptLower = input.prompt.toLowerCase();
  const negativeLower = (input.negativePrompt ?? '').toLowerCase();

  // Trigger words and snippet `#references` are both "leave this token alone"
  // asks, but they need different positional language:
  //   - Trigger words (LoRA activators): position doesn't matter; the LLM
  //     can place them wherever reads best in the enhanced prompt.
  //   - Snippet refs: position MATTERS to the user — the placeholder will be
  //     substituted with a random value at generation time, and the user's
  //     prompt structure was authored around where they put each `#ref`.
  //     Moving `#character` from the subject slot to the end of the prompt
  //     would silently change the composition.
  // So we emit two separate directives. Dedupe is per-list (trigger words and
  // snippets are different concepts; a coincidental name overlap should not
  // collapse them).
  const triggerWords = input.preserveTriggerWords ?? [];
  const snippetTokens = collectSnippetTokens(input);

  if (triggerWords.length > 0) {
    const inPrompt = triggerWords.filter((t) => promptLower.includes(t.toLowerCase()));
    const inNegative = triggerWords.filter((t) => negativeLower.includes(t.toLowerCase()));

    if (inPrompt.length) {
      parts.push(`Preserve these exact trigger words in the prompt: ${inPrompt.join(', ')}`);
    }
    if (inNegative.length) {
      parts.push(
        `Preserve these exact trigger words in the negative prompt: ${inNegative.join(', ')}`
      );
    }
  }

  if (snippetTokens.length > 0) {
    const inPrompt = snippetTokens.filter((t) => promptLower.includes(t.toLowerCase()));
    const inNegative = snippetTokens.filter((t) => negativeLower.includes(t.toLowerCase()));

    // Positional directive — the `#refs` are placeholders that will be
    // substituted at generation time, and where the user put them defines
    // the structural role of that substitution (subject, style, setting,
    // etc.). Asking the LLM to keep them in roughly the same place ensures
    // the enhanced prompt still composes coherently after substitution.
    if (inPrompt.length) {
      parts.push(
        `Preserve these snippet references exactly as written in the prompt, and keep each one in approximately the same position it currently occupies (do not move them to a different part of the prompt): ${inPrompt.join(
          ', '
        )}`
      );
    }
    if (inNegative.length) {
      parts.push(
        `Preserve these snippet references exactly as written in the negative prompt, and keep each one in approximately the same position it currently occupies: ${inNegative.join(
          ', '
        )}`
      );
    }
  }

  parts.push(
    input.negativePrompt != null
      ? `The enhanced prompt and negative prompt must each not exceed ${MAX_PROMPT_LENGTH} characters.`
      : `The enhanced prompt must not exceed ${MAX_PROMPT_LENGTH} characters.`
  );

  if (input.instruction) {
    parts.push(input.instruction);
  }

  if (input.segmentPrompt) {
    parts.push(
      'Organize the enhanced prompt into thematic segments (such as subject, setting, style, lighting, composition). Separate each segment with a blank line. Do not use bullet points or lists.'
    );
  } else if (input.prompt.includes('\n')) {
    parts.push('If possible, try to maintain the original formatting.');
  }

  return parts.length ? parts.join('\n') : '';
}

/**
 * Build the canonical `#category` token list to ask the LLM to preserve.
 * Unions explicit `preserveSnippets` with category names extracted from
 * `snippetTargets` (the raw `snippets.targets` map), normalizes every entry
 * to the `#`-prefixed form, and dedupes case-insensitively.
 */
function collectSnippetTokens(
  input: Pick<PromptEnhancementSchema, 'preserveSnippets' | 'snippetTargets'>
): string[] {
  const seen = new Set<string>(); // lower-case keys for case-insensitive dedupe
  const out: string[] = [];

  const push = (raw: string) => {
    const token = raw.startsWith('#') ? raw : `#${raw}`;
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(token);
  };

  for (const ref of input.preserveSnippets ?? []) push(ref);
  if (input.snippetTargets) {
    for (const refs of Object.values(input.snippetTargets)) {
      for (const ref of refs) push(ref.category);
    }
  }
  return out;
}

export async function enhancePrompt({
  token,
  userId,
  input,
  isGreen,
  isModerator,
  currencies,
}: {
  token: string;
  userId: number;
  input: PromptEnhancementSchema;
  isGreen?: boolean;
  isModerator?: boolean;
  currencies: BuzzSpendType[];
}) {
  const { prompt, negativePrompt } = input;

  // Audit prompt before enhancement
  await auditPromptServer({
    prompt,
    negativePrompt: negativePrompt ?? undefined,
    userId,
    isGreen: !!isGreen,
    isModerator,
  });

  // Audit user-provided enhancement instruction (same rules as prompt)
  if (input.instruction) {
    await auditPromptServer({
      prompt: input.instruction,
      userId,
      isGreen: !!isGreen,
      isModerator,
    });
  }

  const workflow = await submitWorkflow({
    token,
    body: {
      tags: ['prompt-enhancement'],
      metadata: {
        userInstruction: input.instruction ?? undefined,
        preserveTriggerWords: input.preserveTriggerWords ?? undefined,
        preserveSnippets: input.preserveSnippets ?? undefined,
        snippetTargets: input.snippetTargets ?? undefined,
      },
      steps: [createPromptEnhancementStep(input, { name: PROMPT_ENHANCEMENT_STEP_NAME })],
      callbacks: getWorkflowCallbacks(userId),
      // @ts-ignore - BuzzSpendType is properly supported
      currencies: BuzzTypes.toOrchestratorType(currencies),
    },
  });

  return workflow;
}
