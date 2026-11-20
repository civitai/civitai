import type { Kysely } from 'kysely';
import type { CaseIntakeInput } from '@civitai/moderation';
import type { ProcessDefinition } from '@civitai/moderation/process-definition';
import type { DB } from '@civitai/db-schema/kysely';
import { mintAccessToken } from '@civitai/db-queries/access-token';
import { sql } from 'kysely';
import { casesDb, type CasesDb } from './cases.db';
import { enabledDefinition } from './definitions';
import { fileIntakeCase, IntakeRefusedError, submitterRole } from './intake';
import { checkIntakeValues } from './intake-values';
import { createIntakeRateLimit } from './intake-rate-limit';
import { noticeTime, renderNotice } from './notice-render';
import { defaultSendDeps, hashAddress, noticeFrom, sendNotice, type SendDeps } from './send-notice';
import { verifyTurnstile } from './turnstile';

/** How long a party's link opens their case. */
export const PARTY_LINK_DAYS = 365;
/** Receipts one address gets in a day; past it the case is still filed, without the email. */
export const RECEIPTS_PER_ADDRESS_PER_DAY = 5;

export type CaseIntakeResult = {
  publicRef: string;
  receipt: 'queued' | 'duplicate' | 'no-address' | 'no-notice' | 'capped' | 'error';
};

export type CaseIntakeDeps = {
  db: CasesDb;
  /** The main database, where the party's link token lives. */
  mainDb: Kysely<DB>;
  definition: (key: string) => Promise<{ versionId: number; definition: ProcessDefinition } | null>;
  verifyTurnstile: (token: string, ip: string) => Promise<void>;
  rateLimit: (key: string) => void;
  sendDeps: () => Omit<SendDeps, 'holdsLock'>;
  appUrl: string;
  systemUserId: number;
  log: (data: {
    name: string;
    processKey?: string;
    publicRef: string;
    receipt?: string;
    outcome?: string;
  }) => void;
  /** Runs the receipt send after the answer has gone. */
  background: (work: Promise<unknown>) => void;
  now?: () => Date;
};

const notOpen = () => Object.assign(new Error('This form is not open.'), { status: 404 });

/**
 * Files a public takedown request and emails its receipt with the party's private link. The order is
 * cheapest refusal first: the rate limit, the form being open, the values, and only then the Turnstile
 * token, which is spent by checking it. Once the case is filed, the answer is always its reference: a
 * receipt that could not go is recorded on the case for a moderator, never turned into an error that
 * would make the submitter file again.
 */
export async function caseIntake(
  input: CaseIntakeInput,
  deps: CaseIntakeDeps
): Promise<CaseIntakeResult> {
  deps.rateLimit(input.ip);
  const found = await deps.definition(input.processKey);
  if (!found) throw notOpen();
  const { definition: def, versionId } = found;
  const fieldErrors = checkIntakeValues(def, input.values);
  if (Object.keys(fieldErrors).length) throw new IntakeRefusedError(fieldErrors);
  await deps.verifyTurnstile(input.turnstileToken, input.ip);

  const receivedAt = deps.now?.() ?? new Date();
  const filed = await fileIntakeCase(
    {
      definition: def,
      versionId,
      values: input.values,
      submissionId: input.submissionId,
      submitterUserId: input.submitterUserId,
      isTest: input.isTest,
      receivedAt,
    },
    { db: deps.db }
  );
  const done = (receipt: CaseIntakeResult['receipt']) => {
    deps.log({ name: 'case-intake', processKey: def.key, publicRef: filed.publicRef, receipt });
    return { publicRef: filed.publicRef, receipt };
  };
  if (filed.duplicate) return done('duplicate');
  if (!filed.address) return done('no-address');

  const role = submitterRole(def.key);
  const template = def.notices.find((n) => n.id === 'receipt' && n.recipientRole === role);
  if (!template) return done('no-notice');

  try {
    const addressHash = hashAddress(filed.address);
    const { recent } = await deps.db
      .selectFrom('case_notice')
      .select(sql<number>`count(*)::int`.as('recent'))
      .where('notice_id', '=', 'receipt')
      .where('address_hash', '=', addressHash)
      .where('created_at', '>', sql<Date>`now() - interval '1 day'`)
      .executeTakeFirstOrThrow();
    if (recent >= RECEIPTS_PER_ADDRESS_PER_DAY) {
      await recordUnsent(deps.db, filed.caseId, 'capped');
      return done('capped');
    }

    const token = await mintAccessToken(deps.mainDb, {
      resourceType: 'CaseParty',
      resourceId: filed.partyId,
      createdById: deps.systemUserId,
      expiresAt: new Date(receivedAt.getTime() + PARTY_LINK_DAYS * 86_400_000),
    });
    const slots = {
      caseRef: filed.publicRef,
      receivedAt: noticeTime(receivedAt),
      requestType: def.title,
      // In the fragment, so the token never reaches a server log or a Referer header.
      continueLink: `${deps.appUrl}/requests/case/${filed.publicRef}#t=${token}`,
    };
    const notice = await deps.db
      .insertInto('case_notice')
      .values({
        case_id: filed.caseId,
        target_key: 0,
        notice_id: 'receipt',
        recipient_role: role,
        recipient_address: filed.address,
        address_hash: addressHash,
        subject_snapshot: renderNotice(template.subject, slots),
        body_snapshot: renderNotice(template.body, slots),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Sent after answering: the main app gives a case action 5s, and a slow relay must not turn a filed
    // case into "couldn't submit". The row is already pending, so an unsent receipt shows on /cases.
    const publicRef = filed.publicRef;
    const sendDeps = deps.sendDeps();
    deps.background(
      sendNotice(Number(notice.id), {
        ...sendDeps,
        from: noticeFrom(def.key, sendDeps.from),
        // One notice, outside any batch: there is no run lock to hold.
        holdsLock: async () => true,
        replyTo: def.mailbox,
      }).then(
        (outcome) => deps.log({ name: 'case-intake-receipt', publicRef, outcome }),
        (e) => recordUnsent(deps.db, filed.caseId, (e as Error)?.name || 'Error')
      )
    );
    return done('queued');
  } catch (e) {
    await recordUnsent(deps.db, filed.caseId, (e as Error)?.name || 'Error').catch(() => undefined);
    return done('error');
  }
}

/** A receipt that did not go, on the case's timeline. The reason is a code, never a message. */
const recordUnsent = (db: CasesDb, caseId: number, reason: string) =>
  db
    .insertInto('case_event')
    .values({ case_id: caseId, type: 'receipt-unsent', data: JSON.stringify({ reason }) })
    .execute();

const limitPerIp = createIntakeRateLimit({ limit: 10, windowMs: 3_600_000 });

export function defaultCaseIntakeDeps(
  more: Pick<CaseIntakeDeps, 'mainDb' | 'appUrl' | 'systemUserId' | 'log'>
): CaseIntakeDeps {
  return {
    db: casesDb(),
    definition: (key) => enabledDefinition(key),
    verifyTurnstile: (token, ip) => verifyTurnstile(token, ip),
    rateLimit: limitPerIp,
    sendDeps: defaultSendDeps,
    background: (work) =>
      void work.catch((e) => console.error('case receipt send failed', e?.name)),
    ...more,
  };
}
