import type { PromptEnhancementStep } from '@civitai/client';
import type { PromptEnhancementSchema } from '~/server/schema/orchestrator/promptEnhancement.schema';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { getWorkflowCallbacks } from '~/server/orchestrator/orchestrator.utils';

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

  if (input.instruction) {
    parts.push(input.instruction);
  }

  return parts.length ? parts.join('\n') : undefined;
}

export async function enhancePrompt({
  token,
  userId,
  input,
}: {
  token: string;
  userId: number;
  input: PromptEnhancementSchema;
}) {
  const { ecosystem, prompt, negativePrompt, temperature } = input;
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
      currencies: ['yellow'],
    },
  });

  return workflow;
}
