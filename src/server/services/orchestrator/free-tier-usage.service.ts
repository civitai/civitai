import { getFreeTier } from '@civitai/orchestration-client';
import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import { versionIdFromAir } from '~/shared/utils/air';
import type { SessionUser } from '~/types/session';

/** One free-tier window as a usage-limit row. `fixed`: it starts at first use and resets all at once. */
export type FreeUsageRow = {
  id: string;
  area: 'generation';
  label: string;
  limit: number;
  used: number;
  remaining: number;
  windowSeconds: number;
  window: 'fixed';
  nextAt: string | null;
  resetAt: string | null;
};

/** A .NET TimeSpan as serialised: `hh:mm:ss` or `d.hh:mm:ss`. */
export function timeSpanSeconds(value: string): number | null {
  const match = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)(?:\.\d+)?$/.exec(value);
  if (!match) return null;
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function per(seconds: number) {
  if (seconds === 86400) return 'per day';
  if (seconds === 3600) return 'per hour';
  if (seconds === 604800) return 'per week';
  if (seconds % 86400 === 0) return `per ${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `per ${seconds / 3600} hours`;
  return `per ${Math.round(seconds / 60)} minutes`;
}

/**
 * The user's free generation allowance on each free-tier model, read from the orchestrator with
 * their own token. `null` when the orchestrator will not issue them a token (a muted or banned
 * account); `[]` when the free tier is off.
 */
export async function getMyOrchestrationFreeUsage(
  user: SessionUser,
  ctx?: Parameters<typeof getOrchestratorToken>[1]
): Promise<FreeUsageRow[] | null> {
  let token: string;
  try {
    token = await getOrchestratorToken(user.id, ctx);
  } catch (e) {
    if (e instanceof TRPCError && e.code === 'FORBIDDEN') return null;
    throw e;
  }
  const { data, error } = await getFreeTier({ client: createOrchestratorClient(token) });
  if (error || !data) throw new Error('Failed to read free-tier usage');
  if (!data.enabled) return [];

  // Label each bucket by the model behind its AIRs; `key` is the orchestrator's bucket name.
  const versionByKey = new Map<string, number>();
  for (const model of data.models) {
    const versionId = model.airs.map(versionIdFromAir).find((id) => id !== undefined);
    if (versionId !== undefined) versionByKey.set(model.key, versionId);
  }
  const versions = versionByKey.size
    ? await dbRead.modelVersion.findMany({
        where: { id: { in: [...versionByKey.values()] } },
        select: { id: true, model: { select: { name: true } } },
      })
    : [];
  const nameByVersion = new Map(versions.map((v) => [v.id, v.model.name]));

  return data.models.flatMap((model) => {
    const versionId = versionByKey.get(model.key);
    const name = (versionId !== undefined && nameByVersion.get(versionId)) || model.key;
    return model.windows.flatMap((window): FreeUsageRow[] => {
      const seconds = timeSpanSeconds(window.duration);
      if (seconds === null) return [];
      const remaining = Math.max(0, window.remaining);
      const resetAt = window.resetAt ?? null;
      return [
        {
          id: `free.${model.key}.${seconds}`,
          area: 'generation',
          label: `${name}, free ${per(seconds)}`,
          limit: window.limit,
          used: Math.max(0, window.limit - remaining),
          remaining,
          windowSeconds: seconds,
          window: 'fixed',
          nextAt: remaining > 0 ? null : resetAt,
          resetAt,
        },
      ];
    });
  });
}
