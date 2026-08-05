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
 * This is NOT a comics-only path. `prompt-enhance.ts` is reached from
 * `orchestrator.router.ts` `iterateGenerate`, a plain `protectedProcedure` with
 * no flag middleware and `enhance` defaulting to `true` — so any logged-in user
 * hits it on the general generation surface. Only `comics.router.ts` is
 * mod-gated. Treat changes here as touching general generation.
 *
 * The CEILING is measured. undici's default headers timeout was measured at
 * 300.7s (`UND_ERR_HEADERS_TIMEOUT`) against a server that accepts and never
 * responds, and `submitWorkflow` only bounds an attempt with
 * `AbortSignal.timeout` on the whatIf path — a real submit like this one is
 * unbounded client-side. If the wait outlives the headers timeout the fetch
 * throws instead of returning a graceful 202, and `submitWorkflowWithRetry`
 * re-submits: it retries on ANY throw, it is NOT gated on an error allow-list.
 * This body carries no `externalId`, so the orchestrator cannot dedupe and the
 * user is billed for up to 3 chat completions. 120s keeps a 2.5x margin.
 *
 * The FLOOR is measured, with a caveat about the population. From
 * `orchestration_jobs_duration_seconds{job_type="chatCompletion"}` over 7d, on
 * the `ecosystem=other, provider=Civitai` slice (n=1362) — the closest
 * available analogue to this path:
 *
 *     within 60s   96.3% - 98.8%
 *     within 120s  99.3% - 99.9%
 *
 * (ranges, not points: 60 and 120 fall between OTel default histogram buckets
 * and were NOT interpolated.) 120s sits at the knee — beyond it you buy tenths
 * of a percent while holding a Node request open. Day-to-day variance is what
 * decides it: on the two worst of seven days the median moved from <5s into
 * (25,50] and the =<50s fraction fell to ~91%, so 60s degrades materially
 * exactly when the orchestrator is already struggling. That duration INCLUDES
 * queue time (mean claim 7.9s; 27.6% of jobs wait >5s to be claimed), so this
 * wait competes with scheduler backlog, not just token generation.
 *
 * 🔴 CAVEAT: that slice could not be confirmed as this code path. The job
 * metrics carry no `model` or `tags` label, so `gpt-4o-mini` / `tags:['comics']`
 * are not selectable; the slice was identified by component topology
 * (OpenRouter traffic is fronted by spine-controller and reports as
 * `provider=Civitai`). There is NO dp-prod-side span for this submit at all, so
 * nothing measures the long-poll envelope as the Node process experiences it.
 *
 * Why the floor matters: an expired wait returns a 202 with no step output and
 * this function does not check status, so `content` silently becomes ''.
 * `story-plan.ts` refunds (best-effort) and throws, but `prompt-enhance.ts`
 * returns its fallback with NO refund — a silent charge for a discarded
 * completion. Money is unchanged in that band (billed 1x either way), so it is
 * a quality/UX risk rather than a billing one.
 *
 * 🔴 A long-poll can never be the ONLY path: ~1% of jobs run past any value
 * that is safe to hold here. Callers must tolerate the empty-content result.
 */
const CHAT_COMPLETION_WAIT_SECONDS = 120;

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
