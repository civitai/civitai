import { sql } from 'kysely';
import { z } from 'zod';
import { logToAxiom } from '../axiom';
import { casesDb, noticesOfBatch, SENDABLE, type CasesDb } from './cases.db';
import { CASE_TARGET_STATES } from './cases-tables';
import { newPublicRef } from './public-ref';
import { hashAddress } from './send-notice';

/**
 * A one-off import of messages already approved word for word (the 2026-11 takedown backlog). Its input
 * file holds names and addresses, so it is kept out of the repository and handed to `importBatch` by a
 * moderator.
 *
 * Imported cases pin no definition: each message is stored and sent exactly as approved.
 */

const noticeSchema = z.object({
  /** `0` for a message about the whole case, otherwise the `key` of one of the case's targets. */
  target: z.number().int().min(0),
  noticeId: z.string().min(1).max(40),
  recipientRole: z.enum(['claimant', 'uploader']),
  to: z.email(),
  subject: z.string().min(1),
  body: z.string().min(1),
});

const caseSchema = z.object({
  receivedAt: z.iso.datetime(),
  state: z.string().min(1),
  submitter: z.object({ name: z.string().optional(), email: z.email().optional() }).default({}),
  details: z.record(z.string(), z.unknown()).default({}),
  targets: z
    .array(
      z.object({
        key: z.number().int().min(1),
        url: z.string().min(1),
        entityType: z.string().optional(),
        entityId: z.number().int().optional(),
        uploaderUserId: z.number().int().optional(),
        state: z.enum(CASE_TARGET_STATES),
      })
    )
    .default([]),
  notices: z.array(noticeSchema).min(1),
});

export const importInputSchema = z.object({
  batchId: z.string().regex(/^[a-z0-9-]{3,60}$/),
  processKey: z.string().min(1),
  /**
   * How many messages of each notice id the batch must end up sending, from the approved list, not
   * from this file. The counts panel compares `sent` with these, so an import that dropped rows
   * can't read as finished.
   */
  expected: z.record(z.string(), z.number().int().positive()),
  cases: z.array(caseSchema).min(1),
});
export type ImportInput = z.infer<typeof importInputSchema>;

export class ImportRefusedError extends Error {
  readonly status = 409;
}

const batchDefinitionKey = (batchId: string) => `import:${batchId}`;

/** Import every case, target and notice of one batch in one transaction, or none of them. */
export async function importBatch(
  raw: unknown,
  { actorId, db = casesDb() }: { actorId: number; db?: CasesDb }
) {
  const input = importInputSchema.parse(raw);
  for (const c of input.cases) {
    const keys = new Set(c.targets.map((t) => t.key));
    for (const n of c.notices)
      if (n.target !== 0 && !keys.has(n.target))
        throw new ImportRefusedError(
          `notice ${n.noticeId} names target ${n.target}, which its case lacks`
        );
  }

  return db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom('case_record')
      .select('id')
      .where('import_batch_id', '=', input.batchId)
      .limit(1)
      .executeTakeFirst();
    if (existing)
      throw new ImportRefusedError(`batch ${input.batchId} is already imported; undo it first`);

    // The expected counts live on a disabled definition named after the batch, so they are stored
    // with the batch and not in the code.
    const def = await tx
      .insertInto('process_definition')
      .values({ key: batchDefinitionKey(input.batchId), enabled: false })
      .returning('id')
      .executeTakeFirstOrThrow();
    const version = await tx
      .insertInto('process_definition_version')
      .values({
        definition_id: def.id,
        definition: JSON.stringify({ kind: 'import-batch', expected: input.expected }),
        created_by_id: actorId,
        note: `import ${input.batchId}`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('process_definition')
      .set({ current_version_id: version.id })
      .where('id', '=', def.id)
      .execute();

    let notices = 0;
    for (const c of input.cases) {
      const record = await tx
        .insertInto('case_record')
        .values({
          public_ref: newPublicRef(),
          process_key: input.processKey,
          state: c.state,
          source: 'import',
          received_at: c.receivedAt,
          submitter: JSON.stringify(c.submitter),
          details: JSON.stringify(c.details),
          import_batch_id: input.batchId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const targetIds = new Map<number, number>();
      for (const t of c.targets) {
        const row = await tx
          .insertInto('case_target')
          .values({
            case_id: record.id,
            url: t.url,
            entity_type: t.entityType ?? null,
            entity_id: t.entityId ?? null,
            uploader_user_id: t.uploaderUserId ?? null,
            state: t.state,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        targetIds.set(t.key, row.id);
      }

      for (const n of c.notices) {
        await tx
          .insertInto('case_notice')
          .values({
            case_id: record.id,
            target_key: n.target === 0 ? 0 : targetIds.get(n.target)!,
            notice_id: n.noticeId,
            recipient_role: n.recipientRole,
            recipient_address: n.to,
            address_hash: hashAddress(n.to),
            subject_snapshot: n.subject,
            body_snapshot: n.body,
          })
          .execute();
        notices++;
      }

      await tx
        .insertInto('case_event')
        .values({
          case_id: record.id,
          actor_id: actorId,
          type: 'imported',
          data: JSON.stringify({ batchId: input.batchId }),
        })
        .execute();
    }
    return { cases: input.cases.length, notices };
  });
}

/**
 * Delete one batch, children first, in one transaction. Refused once any of its notices has left
 * `pending`: from then on the rows are the record of what was sent.
 *
 * Also refused once the batch was ever exported for the fallback sender: those rows may have been sent
 * there, and a re-import would give them new ids that its sent.jsonl can't match.
 *
 * The cases and notices are locked first. A send can't claim a notice between the check and the
 * delete (a claim that got there first shows as `sending` and refuses the undo; one after finds no
 * row), and a preview can't add a `pii_read` event (its foreign key waits on the case lock). The
 * batch's events go with it; who read its personal data is logged before they do.
 */
export async function undoImport(batchId: string, { db = casesDb() }: { db?: CasesDb } = {}) {
  return db.transaction().execute(async (tx) => {
    const cases = tx.selectFrom('case_record').select('id').where('import_batch_id', '=', batchId);
    await tx
      .selectFrom('case_record')
      .select('id')
      .where('import_batch_id', '=', batchId)
      .forUpdate()
      .execute();
    if ((await exportState(batchId, { db: tx as unknown as CasesDb })) !== 'never')
      throw new ImportRefusedError(
        `batch ${batchId} was exported for the fallback sender; it can't be undone`
      );
    const locked = await tx
      .selectFrom('case_notice')
      .select('status')
      .where('case_id', 'in', cases)
      .forUpdate()
      .execute();
    const moved = locked.filter((n) => n.status !== 'pending').length;
    if (moved > 0)
      throw new ImportRefusedError(
        `${moved} notice(s) of batch ${batchId} are no longer pending; it can't be undone`
      );

    const reads = await tx
      .selectFrom('case_event as e')
      .innerJoin('case_record as c', 'c.id', 'e.case_id')
      .select(['c.public_ref as caseRef', 'e.actor_id as actorId', 'e.at'])
      .where('c.import_batch_id', '=', batchId)
      .where('e.type', '=', 'pii_read')
      .execute();
    if (reads.length) logToAxiom({ name: 'cases.undo.pii-reads', batchId, reads });

    await tx.deleteFrom('case_event').where('case_id', 'in', cases).execute();
    await tx.deleteFrom('case_notice').where('case_id', 'in', cases).execute();
    await tx.deleteFrom('case_party').where('case_id', 'in', cases).execute();
    await tx.deleteFrom('case_target').where('case_id', 'in', cases).execute();
    const deleted = await tx
      .deleteFrom('case_record')
      .where('import_batch_id', '=', batchId)
      .executeTakeFirst();

    const def = await tx
      .selectFrom('process_definition')
      .select('id')
      .where('key', '=', batchDefinitionKey(batchId))
      .executeTakeFirst();
    if (def) {
      await tx
        .updateTable('process_definition')
        .set({ current_version_id: null })
        .where('id', '=', def.id)
        .execute();
      await tx
        .deleteFrom('process_definition_version')
        .where('definition_id', '=', def.id)
        .execute();
      await tx.deleteFrom('process_definition').where('id', '=', def.id).execute();
    }
    return { cases: Number(deleted.numDeletedRows) };
  });
}

export type BatchCount = {
  noticeId: string;
  expected: number | null;
  sent: number;
  failed: number;
  pending: number;
  sending: number;
  /** Sent equals a stated, non-zero expected count, and nothing is failed, pending or sending. */
  done: boolean;
};

/**
 * Sent, failed, pending and sending per notice id, against the batch's stated expected counts. A notice
 * id with no expected count, or with rows but no expectation, is never done.
 */
export async function batchCounts(batchId: string, { db = casesDb() }: { db?: CasesDb } = {}) {
  const def = await db
    .selectFrom('process_definition as d')
    .innerJoin('process_definition_version as v', 'v.id', 'd.current_version_id')
    .select('v.definition')
    .where('d.key', '=', batchDefinitionKey(batchId))
    .executeTakeFirst();
  const expected = ((def?.definition as { expected?: Record<string, number> } | undefined)
    ?.expected ?? {}) as Record<string, number>;

  const rows = await noticesOfBatch(db, batchId)
    .select(['n.notice_id', 'n.status', sql<number>`count(*)::int`.as('n')])
    .groupBy(['n.notice_id', 'n.status'])
    .execute();

  const ids = new Set([...Object.keys(expected), ...rows.map((r) => r.notice_id)]);
  return [...ids].sort().map((noticeId): BatchCount => {
    const of = (status: string) =>
      rows.find((r) => r.notice_id === noticeId && r.status === status)?.n ?? 0;
    const exp = expected[noticeId] ?? null;
    const c = {
      sent: of('sent'),
      failed: of('failed'),
      pending: of('pending'),
      sending: of('sending'),
    };
    return {
      noticeId,
      expected: exp,
      ...c,
      done: !!exp && c.sent === exp && c.failed + c.pending + c.sending === 0,
    };
  });
}

export type ExportState = 'never' | 'outstanding' | 'closed';

/**
 * Whether the batch's unsent rows are out with the fallback sender. `outstanding` from an export until
 * its sent.jsonl is imported; the app sends nothing of the batch meanwhile, because those rows still
 * read as unsent.
 */
export async function exportState(
  batchId: string,
  { db = casesDb() }: { db?: CasesDb } = {}
): Promise<ExportState> {
  const last = await db
    .selectFrom('case_event as e')
    .innerJoin('case_record as c', 'c.id', 'e.case_id')
    .select('e.type')
    .where('c.import_batch_id', '=', batchId)
    .where('e.type', 'in', ['exported', 'export_closed'])
    .orderBy('e.at', 'desc')
    .orderBy('e.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return !last ? 'never' : last.type === 'exported' ? 'outstanding' : 'closed';
}

/** One event on every case of the batch, in `tx`. */
async function recordBatchEvent(tx: CasesDb, batchId: string, type: string, actorId: number) {
  await tx
    .insertInto('case_event')
    .columns(['case_id', 'actor_id', 'type', 'data'])
    .expression(
      tx
        .selectFrom('case_record')
        .select([
          'id',
          sql<number>`${actorId}::int`.as('actor_id'),
          sql<string>`${type}`.as('type'),
          sql<string>`${JSON.stringify({ batchId })}::jsonb`.as('data'),
        ])
        .where('import_batch_id', '=', batchId)
    )
    .execute();
}

/**
 * The batch's unsent rows for the fallback script: ids only, no addresses (the script has its own).
 * Records the export, which holds the batch's in-app sends until the sent.jsonl comes back. The caller
 * holds the batch's run lock, so no send of it is mid-flight.
 */
export async function exportUnsent(
  batchId: string,
  { actorId, db = casesDb() }: { actorId: number; db?: CasesDb }
) {
  return db.transaction().execute(async (tx) => {
    await recordBatchEvent(tx as unknown as CasesDb, batchId, 'exported', actorId);
    return noticesOfBatch(tx as unknown as CasesDb, batchId)
      .select([
        'n.id as rowId',
        'n.notice_id as noticeId',
        'n.recipient_role as recipientRole',
        'c.public_ref as caseRef',
      ])
      .where('n.status', 'in', SENDABLE)
      .orderBy('n.id')
      .execute();
  });
}

const sentLineSchema = z.object({
  rowId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(Number),
  /** What the fallback sender returned for the message (a ticket id). */
  messageId: z.string().min(1).max(200),
  sentAt: z.iso.datetime(),
});

/**
 * Mark rows the fallback script sent. Matches on row id within the batch, and only moves a row that is
 * still `pending` or `failed`: a row already `sent` or `sending` is refused, never overwritten. Closes
 * the batch's export, so the app may send what the fallback didn't.
 */
export async function importSentJsonl(
  batchId: string,
  jsonl: string,
  { actorId, db = casesDb() }: { actorId: number; db?: CasesDb }
) {
  const lines = jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const parsed = lines.map((l, i) => {
    const r = sentLineSchema.safeParse(
      (() => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })()
    );
    if (!r.success) throw new ImportRefusedError(`line ${i + 1} is not a sent record`);
    return r.data;
  });

  return db.transaction().execute(async (tx) => {
    const updated: number[] = [];
    const refused: number[] = [];
    for (const line of parsed) {
      const row = await tx
        .updateTable('case_notice')
        .set({ status: 'sent', message_id: line.messageId, sent_at: line.sentAt, error: null })
        .where('id', '=', line.rowId)
        .where('status', 'in', SENDABLE)
        .where(
          'case_id',
          'in',
          tx.selectFrom('case_record').select('id').where('import_batch_id', '=', batchId)
        )
        .returning(['id', 'case_id'])
        .executeTakeFirst();
      if (!row) {
        refused.push(line.rowId);
        continue;
      }
      updated.push(row.id);
      await tx
        .insertInto('case_event')
        .values({
          case_id: row.case_id,
          actor_id: actorId,
          type: 'notice_sent_elsewhere',
          data: JSON.stringify({ noticeRowId: row.id }),
        })
        .execute();
    }
    await recordBatchEvent(tx as unknown as CasesDb, batchId, 'export_closed', actorId);
    return { updated, refused };
  });
}
