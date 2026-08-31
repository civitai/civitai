import type { PromptEnhancementStepTemplate } from '@civitai/client';
import type { PromptEnhancementSchema } from '~/server/schema/orchestrator/promptEnhancement.schema';
import { buildInstruction } from '~/server/services/orchestrator/promptInstruction';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { getWorkflowCallbacks } from '~/server/orchestrator/orchestrator.utils';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { getAirEcosystem } from '~/shared/utils/air';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';

const PROMPT_ENHANCEMENT_STEP_NAME = 'prompt-enhancement';

export { buildInstruction };

/**
 * Build a `promptEnhancement` step suitable for inclusion in a workflow.
 * Use this in any handler that wants to chain prompt enhancement before a
 * generation step — the step's `output.enhancedPrompt` can then be referenced
 * by the downstream step via `{ $ref: '$N', path: 'output.enhancedPrompt' }`.
 *
 * Pass `suppressOutput: true` to keep the enhancement off user-visible
 * results (typical when the enhancement is an intermediate step).
 *
 * `ecosystem` is normalized here rather than at the call sites: the orchestrator
 * looks the guide up by this exact string and registers whatever it is handed,
 * so an unnormalized value both misses the ecosystem's guide and permanently
 * adds a bogus entry to its registry.
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
      ecosystem: getAirEcosystem(input.ecosystem),
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
