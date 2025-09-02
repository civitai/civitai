import { env } from '~/env/server';
import { QS } from '~/utils/qs';

const baseUrl = `${env.ORCHESTRATOR_ENDPOINT ?? ''}/v1/manager/consumers/flagged`;

async function orchestratorFetch(path: string, opts?: RequestInit) {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
  };
  const response = await fetch(url, { headers, ...opts });
  if (!response.ok) {
    throw new Error(`Orchestrator fetch failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function getFlagged(
  args: { startDate?: Date; reason?: string } = {}
): Promise<Flagged[]> {
  if (!args.startDate) {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    args.startDate = date;
  }
  const startDate = args.startDate.toISOString();
  const response = await orchestratorFetch(`?${QS.stringify({ ...args, startDate })}`);
  return response;
}

export async function getReasons(args: { startDate?: Date } = {}): Promise<FlaggedReason[]> {
  if (!args.startDate) {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    args.startDate = date;
  }
  const startDate = args.startDate.toISOString();
  const response = await orchestratorFetch(`/reasons?${QS.stringify({ ...args, startDate })}`);
  return response;
}

export async function getConsumerStrikes(args: {
  consumerId: string;
}): Promise<ConsumerStikesGroup[]> {
  const response = await orchestratorFetch(`/${args.consumerId}/strikes`);
  return response;
}

export type Flagged = {
  consumerId: string;
  unreviewedStrikes: number;
  totalStrikes: number;
};

export type FlaggedReason = {
  reason: string;
  unreviewedStrikes: number;
  totalStrikes: number;
};

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
    blobs: { id: string; previewUrl: string }[];
  };
};

export type ConsumerStikesGroup = {
  status: string;
  strikes: ConsumerStrike[];
};
