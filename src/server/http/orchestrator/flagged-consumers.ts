import { env } from '~/env/server';
import { outboundFetch } from '~/server/utils/fetch-timeout';

const baseUrl = `${env.ORCHESTRATOR_ENDPOINT ?? ''}/v1/manager/consumers/flagged`;

export class FlaggedConsumerFetchError extends Error {
  constructor(readonly status: number, statusText: string) {
    super(`Orchestrator fetch failed: ${status} ${statusText}`);
  }
}

async function orchestratorFetch(path: string, opts?: RequestInit) {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
  };
  const response = await outboundFetch(url, {
    timeoutMs: 30_000,
    ...opts,
    headers: { ...headers, ...opts?.headers },
  });
  if (!response.ok) throw new FlaggedConsumerFetchError(response.status, response.statusText);
  return response;
}

export async function getConsumerStrikes(args: {
  consumerId: string;
}): Promise<ConsumerStikesGroup[]> {
  const response = await orchestratorFetch(`/${args.consumerId}/strikes`);
  return response.json();
}

export async function reviewConsumerStrikes(args: {
  consumerId: string;
  moderatorId: number;
  notes?: string;
}) {
  await orchestratorFetch(`/${args.consumerId}/strikes/review`, {
    method: 'POST',
    body: JSON.stringify({ moderatorId: args.moderatorId, notes: args.notes ?? '' }),
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
}

export type ConsumerStrike = {
  strike: {
    jobId: string;
    reason: string;
    dateTime: string;
  };
  job: {
    id: string;
    type: string;
    prompt: string;
    negativePrompt?: string;
    resources?: string[];
    blobs?: { id: string; previewUrl: string }[];
  };
};

export type ConsumerStikesGroup = {
  status: string;
  strikes: ConsumerStrike[];
};
