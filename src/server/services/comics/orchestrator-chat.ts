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
 * and were NOT interpolated.) The curve is at its knee in here — past ~120s you
 * buy tenths of a percent while holding a Node request open. Day-to-day
 * variance is what argues against the low end: on the two worst of seven days
 * the median moved from <5s into (25,50] and the =<50s fraction fell to ~91%,
 * so 60s degrades materially exactly when the orchestrator is already
 * struggling. 90 sits above that degradation and below the edge cut below.
 *
 * That duration INCLUDES time before the job was claimed (`JobGrain.cs`:
 * `JobDuration = UtcNow - job.CreatedAt`), but queue is a SMALL part of it —
 * so the number above is essentially execution time, not backlog.
 * `orchestration_jobs_priority_delay_seconds_total` records exactly this
 * per job (`JobDuration - ClaimDuration`, i.e. job creation -> start of the
 * claim that finished it): 1166.63s over 1428 jobs = **0.82s mean**, ~6% of
 * the 13.8s mean job duration, same window and selector.
 *
 * Do NOT compute this by subtracting the two duration histograms.
 * `ClaimDuration = UtcNow - claim.CreatedDate` is how long a claim LASTED, not
 * how long a job waited for one, and `IsFinalClaimEvent` also fires on
 * Rejected/LateRejected/ClaimExpired — measured, 2294 claim observations
 * against 1428 job observations (765 of them rejected claims). The two means
 * are over different populations, and the two plausible subtractions give ~5s
 * and ~0s. Use `priority_delay`. (It is time-to-FINAL-claim, so it still
 * includes time burnt by earlier rejected attempts; pure first-claim queue wait
 * is not exposed by any current metric.)
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
 * 🔴 THE EDGE, which is why this is 90 and not 120. `iterateGenerate` is
 * browser-driven, so its response crosses Cloudflare. The zone's plan is
 * "Business Website" (read from the CF API) — NOT Enterprise, and
 * `proxy_read_timeout` is Enterprise-only, so the ~100s default applies and
 * cannot have been raised. A wait longer than that is not merely wasted: the
 * browser gets a 524 while the origin keeps holding the socket AND the workflow
 * keeps running and billing, so the user sees an error for a completion that
 * was about to succeed. 90 keeps ~10s of margin under it. The cost is small —
 * between the 60s and 120s rows above, i.e. a fraction of a percent — and it is
 * a fraction that browser callers could never have collected anyway.
 *
 * Two honesty notes. The 100s is inferred from the plan tier, NOT read: the
 * available token lacks Zone-Settings:Read, so `GET /zones/{id}/settings/
 * proxy_read_timeout` returns Unauthorized. And origin logs neither confirm nor
 * refute it — plenty of requests return 200 well past 100s, but CF can 524 the
 * browser while leaving the origin connection open, which is invisible from
 * this side. (There IS an unexplained hard abort at ~125.0s: 4,158 status-499s
 * over 3d clustered at 125.006-125.011s across 256 client IPs. Not attributed —
 * no evidence names the actor — but 90 sits under it too.)
 *
 * The robust fix, if this ever needs to be longer: CF's 524 clock is a READ
 * timeout that resets on any byte from origin, so a long-poll that flushes
 * headers early or emits a keepalive never accumulates toward it, and the plan
 * tier stops mattering. That is a change to the orchestrator's response
 * behaviour, not to this constant.
 *
 * 🔴 A long-poll can never be the ONLY path: ~1% of jobs run past any value
 * that is safe to hold here. Callers must tolerate the empty-content result.
 */
const CHAT_COMPLETION_WAIT_SECONDS = 90;

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
