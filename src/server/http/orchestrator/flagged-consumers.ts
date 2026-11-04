import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

const baseUrl = `${env.ORCHESTRATOR_ENDPOINT ?? ''}/v1/manager/consumers/flagged`;

async function orchestratorFetch(path: string, opts?: RequestInit & { allowNotFound?: boolean }) {
  const { allowNotFound, ...init } = opts ?? {};
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
  };
  const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
  if (allowNotFound && response.status === 404)
    return { notFound: await response.text().catch(() => '') };
  if (!response.ok) {
    throw new Error(`Orchestrator fetch failed: ${response.status} ${response.statusText}`);
  }
  return response;
}

/**
 * A consumer the orchestrator has never flagged has no record, and the strikes read answers 404 for
 * it: that is "no strikes", not a failure. Every other non-2xx still throws.
 */
export async function getConsumerStrikes(args: {
  consumerId: string;
}): Promise<ConsumerStikesGroup[]> {
  const response = await orchestratorFetch(`/${args.consumerId}/strikes`, { allowNotFound: true });
  if ('notFound' in response) {
    // Logged every time: a removed route or a proxy answering 404 would otherwise read as "no strikes".
    logToAxiom({
      name: 'orchestrator-flagged-consumers',
      type: 'warning',
      message: 'strikes read answered 404; treated as no strikes',
      consumerId: args.consumerId,
      body: response.notFound.slice(0, 500),
    }).catch(() => undefined);
    return [];
  }
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
