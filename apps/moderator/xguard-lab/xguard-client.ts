/**
 * Direct orchestrator client for XGuard prompt scans.
 *
 * Two things verified against prod that this relies on:
 *   - A label in `labelOverrides` does NOT have to exist in the live registry, so a candidate
 *     label set can be evaluated without writing anything to the orchestrator.
 *   - Passing `labels` restricts evaluation to those labels only: one model call per row instead
 *     of fourteen.
 *
 * `storeFullResponse` is what makes the model's explanation come back. Without it `modelReason` is
 * an empty string with `finishReason: 'length'`, which reads like a bug and is really an opt-in.
 */
export type LabelPolicy = {
  label: string;
  policy: string;
  threshold: number;
  action?: string;
};

export type LabelResult = {
  label: string;
  score: number;
  triggered: boolean;
  topToken?: string;
  modelReason?: string;
  finishReason?: string;
  policyHash?: string;
};

export type XGuardInput = {
  positivePrompt: string;
  negativePrompt?: string | null;
};

/**
 * Which scanner to evaluate against. `prompt` and `text` are separate registries with separate
 * label sets and separate thresholds, so this is not cosmetic: a policy tuned in one mode says
 * nothing about the other, which is the same warning `/xguard/docs` gives about thresholds not
 * transferring between scanners.
 *
 * Model listings are scanned in `text` mode in production (`model-moderation.adapter.ts`), so a
 * sample drawn from a model must be evaluated in `text` mode or the loop optimises the wrong
 * scanner. Prompt stays the default because every existing batch is generation prompts.
 */
export type XGuardMode = 'prompt' | 'text';

type WorkflowResponse = {
  status?: string;
  steps?: Array<{ $type?: string; output?: { results?: LabelResult[] } }>;
};

export type OrchestratorConfig = { endpoint: string; token: string };

// SvelteKit reads env through `$env/dynamic/private`, not `process.env`, so a caller inside the app passes
// its config in; the CLIs fall back to the environment.
export function orchestratorConfig(override?: Partial<OrchestratorConfig>): OrchestratorConfig {
  const endpoint = override?.endpoint ?? process.env.ORCHESTRATOR_ENDPOINT;
  const token =
    override?.token ?? process.env.ORCHESTRATOR_ACCESS_TOKEN ?? process.env.ORCHESTRATOR_TOKEN;
  if (!endpoint) throw new Error('ORCHESTRATOR_ENDPOINT not set');
  if (!token) throw new Error('ORCHESTRATOR_ACCESS_TOKEN not set');
  return { endpoint: endpoint.replace(/\/$/, ''), token };
}

export async function scan(args: {
  input: XGuardInput;
  policies: LabelPolicy[];
  mode?: XGuardMode;
  wait?: number;
  withReason?: boolean;
  orchestrator?: Partial<OrchestratorConfig>;
}): Promise<LabelResult[]> {
  const { endpoint, token } = orchestratorConfig(args.orchestrator);
  const { input, policies, mode = 'prompt', wait = 60, withReason = true } = args;

  // An empty policy string means "use whatever the live registry has", so it must not be sent as
  // an override - that is how a baseline run works.
  const overrides = policies
    .filter((p) => p.policy.trim().length > 0)
    .map((p) => ({
      label: p.label,
      action: p.action ?? 'Scan',
      threshold: p.threshold,
      policy: p.policy,
    }));

  // Text mode carries the content as `text` and has no negative prompt; the shapes are not
  // interchangeable, so build them separately rather than spreading a common object.
  const modeInput =
    mode === 'text'
      ? { mode: 'text' as const, text: input.positivePrompt }
      : {
          mode: 'prompt' as const,
          positivePrompt: input.positivePrompt,
          negativePrompt: input.negativePrompt ?? '',
        };

  const body = {
    steps: [
      {
        $type: 'xGuardModeration',
        input: {
          ...modeInput,
          labels: policies.map((p) => p.label),
          storeFullResponse: withReason,
          ...(overrides.length > 0 ? { labelOverrides: overrides } : {}),
        },
      },
    ],
  };

  const res = await fetch(`${endpoint}/v2/consumer/workflows?wait=${wait}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`orchestrator HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const json = (await res.json()) as WorkflowResponse;
  const step = json.steps?.find((s) => s.$type === 'xGuardModeration');
  const results = step?.output?.results;
  if (!results) throw new Error(`no xGuardModeration output (status ${json.status})`);
  return results;
}
