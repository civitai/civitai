import type { getTrainingRuns } from '../user-account.service';
import { LORA_ROWS } from '$lib/tickets/lora-panel';

/**
 * One training run. Spend, hyperparameters, the submit history and dataset details are deliberately not
 * carried: the card says what was trained and whether it can be published, nothing else.
 */
export type LoraRun = {
  modelVersionId: number;
  modelId: number;
  modelName: string | null;
  name: string | null;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Per model, not per version: `meta.cannotPublish` lives on the model. */
  cannotPublish: boolean;
};

export type TicketLora =
  | { status: 'unlinked' }
  | { status: 'unavailable'; userId: number }
  | {
      status: 'ok';
      userId: number;
      /** The owner's username, for the training models page's exact-match filter; null with no runs. */
      username: string | null;
      runs: LoraRun[];
      truncated: boolean;
    };

export type LoraReads = {
  runs: (userId: number, limit: number) => ReturnType<typeof getTrainingRuns>;
  /** The models of a run list: which are blocked from publishing, and the owner's username. */
  models: (
    userId: number,
    modelIds: number[]
  ) => Promise<{ username: string | null; blocked: Set<number> }>;
};

// Imported when read, so loading the ticket detail module opens no database or ClickHouse connection.
const liveReads: LoraReads = {
  runs: async (userId, limit) =>
    (await import('../user-account.service')).getTrainingRuns(userId, limit),
  models: async (userId, modelIds) => {
    const [{ dbRead }, { sql }] = await Promise.all([
      import('../db'),
      import('@civitai/db/kysely'),
    ]);
    const rows = await dbRead
      .selectFrom('Model as m')
      .innerJoin('User as u', 'u.id', 'm.userId')
      .select([
        'm.id',
        'u.username',
        sql<boolean>`COALESCE(m.meta->'cannotPublish' = 'true'::jsonb, false)`.as('cannotPublish'),
      ])
      .where('m.id', 'in', modelIds)
      .where('m.userId', '=', userId)
      .where('m.deletedAt', 'is', null)
      .execute();
    return {
      username: rows[0]?.username ?? null,
      blocked: new Set(rows.filter((r) => r.cannotPublish).map((r) => r.id)),
    };
  },
};

/**
 * The linked user's recent training runs and whether each model is blocked from publishing. The caller
 * has checked the training models page grant (`PANELS.lora.readGrants`). A failing read is `unavailable`.
 */
export async function loraSectionFor(
  ticket: { userId: number },
  reads: LoraReads = liveReads
): Promise<Extract<TicketLora, { status: 'ok' | 'unavailable' }>> {
  const { userId } = ticket;
  try {
    // `charges` is the Buzz spend; it is read by the service and dropped here.
    const { runs, truncated } = await reads.runs(userId, LORA_ROWS);
    const { username, blocked } = runs.length
      ? await reads.models(userId, [...new Set(runs.map((r) => r.modelId))])
      : { username: null, blocked: new Set<number>() };
    return {
      status: 'ok',
      userId,
      username,
      truncated,
      runs: runs.map(
        (r): LoraRun => ({
          modelVersionId: r.modelVersionId,
          modelId: r.modelId,
          modelName: r.modelName,
          name: r.name,
          status: r.status,
          createdAt: r.submittedAt ?? r.startedAt,
          updatedAt: r.completedAt,
          cannotPublish: blocked.has(r.modelId),
        })
      ),
    };
  } catch (e) {
    console.error('[tickets] lora runs failed', e);
    return { status: 'unavailable', userId };
  }
}
