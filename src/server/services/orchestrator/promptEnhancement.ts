import type {
  PromptEnhancementInput,
  PromptEnhancementOutput,
  PromptEnhancementStep,
} from '@civitai/client';
import type { PromptEnhancementSchema } from '~/server/schema/orchestrator/promptEnhancement.schema';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';

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
  input,
}: {
  token: string;
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
      currencies: ['yellow'],
    },
    query: { wait: 30 },
  });

  const step = workflow.steps?.find(
    (s): s is PromptEnhancementStep => s.name === PROMPT_ENHANCEMENT_STEP_NAME
  );

  return {
    workflowId: workflow.id,
    output: step?.output as PromptEnhancementOutput | undefined,
  };
}
