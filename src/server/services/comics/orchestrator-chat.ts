import type { ChatCompletionStep, ChatCompletionStepTemplate } from '@civitai/client';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';

type ChatMessage = {
  role: string;
  content: any;
};

/**
 * Submit a chat completion via the orchestrator workflow API.
 * The user's Buzz is deducted automatically via the token.
 */
export async function orchestratorChatCompletion(input: {
  token: string;
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<{
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  const { token, model = 'gpt-4o-mini', messages, temperature, maxTokens } = input;

  const workflow = await submitWorkflow({
    token,
    body: {
      steps: [
        {
          $type: 'chatCompletion',
          input: {
            model,
            messages: messages as any,
            temperature,
            maxTokens,
          },
        } as ChatCompletionStepTemplate,
      ],
      tags: ['comics'],
      currencies: ['yellow'],
    },
    query: { wait: 60000 },
  });

  const step = workflow.steps?.[0] as ChatCompletionStep | undefined;
  const output = step?.output;
  const content = output?.choices?.[0]?.message?.content?.trim() ?? '';

  return {
    content,
    usage: output?.usage
      ? {
          promptTokens: output.usage.promptTokens,
          completionTokens: output.usage.completionTokens,
          totalTokens: output.usage.promptTokens + output.usage.completionTokens,
        }
      : undefined,
  };
}

/**
 * Estimate the Buzz cost of a chat completion without executing it.
 */
export async function orchestratorChatCompletionCost(input: {
  token: string;
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}): Promise<{ cost: number; ready: boolean }> {
  const { token, model = 'gpt-4o-mini', messages, temperature, maxTokens } = input;

  try {
    const workflow = await submitWorkflow({
      token,
      body: {
        steps: [
          {
            $type: 'chatCompletion',
            input: {
              model,
              messages: messages as any,
              temperature,
              maxTokens,
            },
          } as ChatCompletionStepTemplate,
        ],
        tags: ['comics'],
        currencies: ['yellow'],
      },
      query: { whatif: true },
    });

    return { cost: workflow.cost?.total ?? 0, ready: true };
  } catch {
    return { cost: 0, ready: false };
  }
}
