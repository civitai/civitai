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

type WorkflowResponse = {
  status?: string;
  steps?: Array<{ $type?: string; output?: { results?: LabelResult[] } }>;
};

export function orchestratorConfig() {
  const endpoint = process.env.ORCHESTRATOR_ENDPOINT;
  const token = process.env.ORCHESTRATOR_ACCESS_TOKEN ?? process.env.ORCHESTRATOR_TOKEN;
  if (!endpoint) throw new Error('ORCHESTRATOR_ENDPOINT not set');
  if (!token) throw new Error('ORCHESTRATOR_ACCESS_TOKEN not set');
  return { endpoint: endpoint.replace(/\/$/, ''), token };
}

export async function scan(args: {
  input: XGuardInput;
  policies: LabelPolicy[];
  wait?: number;
  withReason?: boolean;
}): Promise<LabelResult[]> {
  const { endpoint, token } = orchestratorConfig();
  const { input, policies, wait = 60, withReason = true } = args;

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

  const body = {
    steps: [
      {
        $type: 'xGuardModeration',
        input: {
          mode: 'prompt',
          positivePrompt: input.positivePrompt,
          negativePrompt: input.negativePrompt ?? '',
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
