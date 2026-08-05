import type { ChatCompletionStep, ChatCompletionStepTemplate } from '@civitai/client';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';

type ChatMessage = {
  role: string;
  content: any;
};

/**
 * How long to hold the submit open waiting for the completion, in SECONDS.
 *
 * The orchestrator binds `?wait` as `[FromQuery] int` and applies it as
 * `TimeSpan.FromSeconds(wait)` — seconds, and it applies NO server-side clamp,
 * so whatever we send is held verbatim. This constant is named for its unit for
 * the same reason `SCAN_WAIT_SECONDS` / `PERCEPTUAL_HASH_WAIT_SECONDS` are: the
 * unit is invisible at the call site, and this site previously passed `60000`
 * (a millisecond value) — a request to hold the socket for ~16.7 hours.
 *
 * 60s is chosen to sit in the gap between two hard bounds:
 *  - ABOVE what a `gpt-4o-mini` completion needs (both consumers cap at
 *    maxTokens 2048/512, i.e. seconds). Expiring early is not free: the
 *    orchestrator returns 202 with no step output, which makes `content` empty
 *    — `prompt-enhance` degrades to its fallback, but `story-plan` throws and
 *    refunds the user's Buzz.
 *  - WELL BELOW undici's ~300s default headers timeout. That matters because
 *    `submitWorkflow` only bounds an attempt with `AbortSignal.timeout` on the
 *    whatIf path; a real submit like this one is unbounded client-side. If the
 *    wait outlives the headers timeout, the fetch throws instead of returning a
 *    202, `submitWorkflowWithRetry` classifies that as transient and re-submits
 *    — and this body carries no `externalId`, so the orchestrator cannot dedupe
 *    and the user is billed for up to 3 chat completions.
 */
const CHAT_COMPLETION_WAIT_SECONDS = 60;

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
  currencies?: BuzzSpendType[];
}): Promise<{
  content: string;
  workflowId: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  const { token, model = 'gpt-4o-mini', messages, temperature, maxTokens, currencies } = input;

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
      currencies: BuzzTypes.toOrchestratorType(currencies ?? ['yellow']),
    },
    query: { wait: CHAT_COMPLETION_WAIT_SECONDS },
  });

  const step = workflow.steps?.[0] as ChatCompletionStep | undefined;
  const output = step?.output;
  const content = output?.choices?.[0]?.message?.content?.trim() ?? '';

  return {
    content,
    workflowId: workflow.id as string,
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
  currencies?: BuzzSpendType[];
}): Promise<{ cost: number; ready: boolean }> {
  const { token, model = 'gpt-4o-mini', messages, temperature, maxTokens, currencies } = input;

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
        currencies: BuzzTypes.toOrchestratorType(currencies ?? ['yellow']),
      },
      query: { whatif: true },
    });

    return { cost: workflow.cost?.total ?? 0, ready: true };
  } catch {
    return { cost: 0, ready: false };
  }
}
