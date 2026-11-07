import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { getWorkflow } from '~/server/services/orchestrator/workflows';

// The I/O half of the moderator App refund (`app-workflow-refund.service.ts`): every database and
// orchestrator read or write it makes, and nothing else. Kept apart so the money logic can be tested
// against fixtures, and so each statement here is one place to read.
//
// Every read is on the PRIMARY. A refund decides from these rows whether money is still owed, and a
// replica a moment behind a reversal would answer "still owed".

/** `block_workflows`: written at submit for every non-dev App Blocks generation. */
export type BlockWorkflowRecord = {
  workflowId: string;
  userId: number;
  appBlockId: string;
  status: string;
  submittedAt: Date;
};

/** `block_spend_attribution`: written after a successful submit, fire-and-forget. */
export type BlockSpendRecord = {
  workflowId: string;
  userId: number;
  appBlockId: string;
  status: string;
  attributedAt: Date;
};

/** `block_author_fee_accrual`: one row per workflow that was charged an author fee. */
export type BlockFeeAccrualRecord = {
  workflowId: string;
  viewerUserId: number;
  appBlockId: string;
  appOwnerUserId: number;
  status: string;
  feeBuzz: number;
  buzzType: string;
  accruedAt: Date;
};

export type AppWorkflowRecords = {
  workflows: BlockWorkflowRecord[];
  spends: BlockSpendRecord[];
  fees: BlockFeeAccrualRecord[];
};

/**
 * What the platform recorded about these workflows. A workflow id found in none of the three tables
 * was not submitted through App Blocks (or was a dev-harness run, which writes none of them).
 */
export async function getAppWorkflowRecords(workflowIds: string[]): Promise<AppWorkflowRecords> {
  if (workflowIds.length === 0) return { workflows: [], spends: [], fees: [] };
  const [workflows, spends, fees] = await Promise.all([
    dbWrite.$queryRaw<BlockWorkflowRecord[]>`
      SELECT "workflow_id" AS "workflowId", "user_id" AS "userId", "app_block_id" AS "appBlockId",
             "status", "submitted_at" AS "submittedAt"
      FROM "block_workflows"
      WHERE "workflow_id" = ANY(${workflowIds}::text[])
    `,
    dbWrite.$queryRaw<BlockSpendRecord[]>`
      SELECT "workflow_id" AS "workflowId", "user_id" AS "userId", "app_block_id" AS "appBlockId",
             "status", "attributed_at" AS "attributedAt"
      FROM "block_spend_attribution"
      WHERE "workflow_id" = ANY(${workflowIds}::text[])
    `,
    dbWrite.$queryRaw<BlockFeeAccrualRecord[]>`
      SELECT "workflow_id" AS "workflowId", "viewer_user_id" AS "viewerUserId",
             "app_block_id" AS "appBlockId", "app_owner_user_id" AS "appOwnerUserId", "status",
             "fee_buzz" AS "feeBuzz", "buzz_type" AS "buzzType", "accrued_at" AS "accruedAt"
      FROM "block_author_fee_accrual"
      WHERE "workflow_id" = ANY(${workflowIds}::text[])
    `,
  ]);
  return { workflows, spends, fees };
}

/**
 * The workflow ids one account ran through App Blocks in `[from, to)`, newest first. A union of the
 * three tables because none of them alone is complete: `block_workflows` skips nothing a viewer ran
 * but is best-effort, and the other two are only written for a spend that went through.
 *
 * ⚠️ `block_spend_attribution` and `block_author_fee_accrual` have no index on the SPENDER — theirs
 * lead with the app, the owner or the author. Both are small, and this is a moderator read.
 */
export async function listAppWorkflowIdsForUser(input: {
  userId: number;
  appBlockId?: string;
  from: Date;
  to: Date;
  limit: number;
}): Promise<string[]> {
  const { userId, appBlockId, from, to, limit } = input;
  const app = appBlockId ? Prisma.sql`AND "app_block_id" = ${appBlockId}` : Prisma.empty;
  const rows = await dbWrite.$queryRaw<{ workflowId: string }[]>`
    SELECT "workflowId"
    FROM (
      SELECT "workflow_id" AS "workflowId", "submitted_at" AS "at"
      FROM "block_workflows"
      WHERE "user_id" = ${userId} AND "submitted_at" >= ${from} AND "submitted_at" < ${to}
        ${app}
      UNION ALL
      SELECT "workflow_id", "attributed_at"
      FROM "block_spend_attribution"
      WHERE "user_id" = ${userId} AND "attributed_at" >= ${from} AND "attributed_at" < ${to}
        ${app}
      UNION ALL
      SELECT "workflow_id", "accrued_at"
      FROM "block_author_fee_accrual"
      WHERE "viewer_user_id" = ${userId} AND "accrued_at" >= ${from} AND "accrued_at" < ${to}
        ${app}
    ) t
    GROUP BY "workflowId"
    ORDER BY MAX("at") DESC, "workflowId" DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => row.workflowId);
}

/**
 * A listing id or slug to the app block it hosts. `null` for a listing that does not exist or hosts
 * no block (an off-site listing). Shadow revisions are not listings a moderator names.
 */
export async function resolveListingAppBlockId(listing: string): Promise<string | null> {
  const rows = await dbWrite.$queryRaw<{ appBlockId: string | null }[]>`
    SELECT "app_block_id" AS "appBlockId"
    FROM "app_listings"
    WHERE ("id" = ${listing} OR "slug" = ${listing}) AND "revision_of_id" IS NULL
    LIMIT 1
  `;
  return rows[0]?.appBlockId ?? null;
}

/** Display names: the store listing's name, else the block's own id. */
export async function getAppNames(appBlockIds: string[]): Promise<Map<string, string>> {
  if (appBlockIds.length === 0) return new Map();
  const rows = await dbWrite.$queryRaw<{ appBlockId: string; name: string }[]>`
    SELECT ab."id" AS "appBlockId", COALESCE(al."name", ab."block_id") AS "name"
    FROM "app_blocks" ab
    LEFT JOIN "app_listings" al ON al."app_block_id" = ab."id" AND al."revision_of_id" IS NULL
    WHERE ab."id" = ANY(${appBlockIds}::text[])
  `;
  return new Map(rows.map((row) => [row.appBlockId, row.name]));
}

export type OrchestratorTransaction = {
  type: string;
  amount: number;
  id: string | null;
  accountType: string;
};

export type OrchestratorWorkflowCharges =
  | { found: true; status: string; transactions: OrchestratorTransaction[] }
  | { found: false };

/**
 * The orchestrator's own record of what a workflow charged and credited.
 *
 * 🔴 THIS IS THE ONLY PLACE THE GENERATION CHARGE CAN BE FOUND BY ID. The orchestrator debits the
 * viewer with a Buzz multi-transaction that carries no external id prefix, so the legs cannot be
 * listed by prefix the way civitai-made charges can; it records each leg's Buzz transaction id on
 * the workflow's `transactions.list` instead, and its own refunds as `credit` entries there.
 *
 * Read with the system token, as the moderator training refresh does: a moderator acts on someone
 * else's workflow, and the viewer's own token is not ours to mint for that.
 */
export async function getOrchestratorWorkflowCharges(
  workflowId: string
): Promise<OrchestratorWorkflowCharges> {
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!token) throw new Error('ORCHESTRATOR_ACCESS_TOKEN is not configured');
  try {
    const workflow = await getWorkflow({ token, path: { workflowId } });
    return {
      found: true,
      status: String(workflow.status ?? 'unknown'),
      transactions: (workflow.transactions?.list ?? []).map((t) => ({
        type: t.type,
        amount: t.amount,
        id: t.id ?? null,
        accountType: t.accountType,
      })),
    };
  } catch (error) {
    // `getWorkflow` maps a 404 to NOT_FOUND and a 400 (a malformed id) to BAD_REQUEST; both mean
    // there is no such workflow to refund. A 401/403 is the system token being refused, and a 5xx or
    // network failure is SERVICE_UNAVAILABLE — those propagate, because they say nothing about
    // whether the workflow exists.
    if (error instanceof TRPCError && (error.code === 'NOT_FOUND' || error.code === 'BAD_REQUEST'))
      return { found: false };
    throw error;
  }
}
