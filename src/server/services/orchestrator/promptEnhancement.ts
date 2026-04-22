import type { PromptEnhancementStep } from '@civitai/client';
import type { PromptEnhancementSchema } from '~/server/schema/orchestrator/promptEnhancement.schema';
import { MAX_PROMPT_LENGTH } from '~/shared/data-graph/generation/common';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { getWorkflowCallbacks } from '~/server/orchestrator/orchestrator.utils';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';

const PROMPT_ENHANCEMENT_STEP_NAME = 'prompt-enhancement';

function buildInstruction(input: PromptEnhancementSchema): string | undefined {
  const parts: string[] = [];

  if (input.preserveTriggerWords?.length) {
    const words = input.preserveTriggerWords;
    const promptLower = input.prompt.toLowerCase();
    const negativeLower = (input.negativePrompt ?? '').toLowerCase();

    const inPrompt = words.filter((w) => promptLower.includes(w.toLowerCase()));
    const inNegative = words.filter((w) => negativeLower.includes(w.toLowerCase()));

    if (inPrompt.length) {
      parts.push(`Preserve these exact trigger words in the prompt: ${inPrompt.join(', ')}`);
    }
    if (inNegative.length) {
      parts.push(
        `Preserve these exact trigger words in the negative prompt: ${inNegative.join(', ')}`
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
  } else {
    parts.push('If possible, try to maintain the original formatting.');
  }

  return parts.length ? parts.join('\n') : undefined;
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
  const { ecosystem, prompt, negativePrompt, temperature } = input;

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

  const instruction = buildInstruction(input);

  const workflow = await submitWorkflow({
    token,
    body: {
      tags: ['prompt-enhancement'],
      metadata: {
        userInstruction: input.instruction ?? undefined,
        preserveTriggerWords: input.preserveTriggerWords ?? undefined,
      },
      steps: [
        {
          $type: 'promptEnhancement',
          name: PROMPT_ENHANCEMENT_STEP_NAME,
          input: {
            ecosystem,
            prompt,
            negativePrompt: negativePrompt ?? undefined,
            temperature: temperature ?? undefined,
            instruction,
          },
        } as PromptEnhancementStep,
      ],
      callbacks: getWorkflowCallbacks(userId),
      // @ts-ignore - BuzzSpendType is properly supported
      currencies: BuzzTypes.toOrchestratorType(currencies),
    },
  });

  return workflow;
}
