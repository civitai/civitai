import type { Kysely } from 'kysely';
import { sendEmailStrict } from '@civitai/email';
import { env } from '$env/dynamic/private';
import type { CaseIntakeInput } from '@civitai/moderation';
import type { ProcessDefinition } from '@civitai/moderation/process-definition';
import type { DB } from '@civitai/db-schema/kysely';
import { mintAccessToken } from '@civitai/db-queries/access-token';
import { sql } from 'kysely';
import { casesDb, type CasesDb } from './cases.db';
import { enabledDefinition } from './definitions';
import { fileIntakeCase, IntakeRefusedError, isMinorFlagged, submitterRole } from './intake';
import { checkIntakeValues } from './intake-values';
import { createIntakeRateLimit } from './intake-rate-limit';
import { noticeTime, renderNotice } from './notice-render';
import { defaultSendDeps, hashAddress, noticeFrom, sendNotice, type SendDeps } from './send-notice';
import { verifyTurnstile } from './turnstile';

/** How long a party's link opens their case. */
export const PARTY_LINK_DAYS = 365;
/** Stands for the party's link token in a stored notice; the token goes only into the sent mail. */
export const LINK_TOKEN_PLACEHOLDER = '[link-token]';
/** Receipts one address gets in a day; past it the case is still filed, without the email. */
export const RECEIPTS_PER_ADDRESS_PER_DAY = 5;
/** Receipts sent in any hour, all addresses. */
export const RECEIPTS_PER_HOUR = 100;

export type CaseIntakeResult = {
  publicRef: string;
  receipt: 'queued' | 'duplicate' | 'no-address' | 'no-notice' | 'capped' | 'error';
};

export type CaseIntakeDeps = {
  db: CasesDb;
  mainDb: Kysely<DB>;
  definition: (key: string) => Promise<{ versionId: number; definition: ProcessDefinition } | null>;
  verifyTurnstile: (token: string, ip: string) => Promise<{ hostname: string } | void>;
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
  alert: (subject: string, text: string) => Promise<unknown>;
  background: (work: Promise<unknown>) => void;
  now?: () => Date;
};

const notOpen = () =>
  Object.assign(new Error('This form is not open.'), { status: 404, public: true });

/**
 * Files a public takedown request and emails its receipt with the party's private link. The order is
 * cheapest refusal first: the rate limit, the form being open, the values, and only then the Turnstile
 * token, which is spent by checking it. Once the case is filed, the answer is always its reference: a
 * receipt that was capped, or failed before or while being queued, is recorded as `receipt-unsent`; one
 * the send refuses (brake, ceiling, lockdown, relay) stays as its case_notice row with a log line.
 * Neither becomes an error that would make the submitter file again.
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
  const challenge = await deps.verifyTurnstile(input.turnstileToken, input.ip);

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
      originHost: challenge?.hostname,
    },
    { db: deps.db }
  );
  const done = (receipt: CaseIntakeResult['receipt']) => {
    deps.log({ name: 'case-intake', processKey: def.key, publicRef: filed.publicRef, receipt });
    return { publicRef: filed.publicRef, receipt };
  };
  if (filed.duplicate) return done('duplicate');
  // The case reference only: nothing the submitter wrote goes in an alert.
  if (isMinorFlagged(input.values))
    deps.background(
      deps
        .alert(
          `Minor flagged on takedown case ${filed.publicRef}`,
          `A ${def.title} request filed as ${filed.publicRef} says the person shown is or was under 18.`
        )
        .catch((e) =>
          recordEvent(deps.db, filed.caseId, 'minor-alert-unsent', (e as Error)?.name || 'Error')
        )
    );
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
    const { lastHour } = await deps.db
      .selectFrom('case_notice')
      .select(sql<number>`count(*)::int`.as('lastHour'))
      .where('notice_id', '=', 'receipt')
      .where('created_at', '>', sql<Date>`now() - interval '1 hour'`)
      .executeTakeFirstOrThrow();
    // Both caps skip only the email, so a flood of forms can't pause every other case notice.
    if (recent >= RECEIPTS_PER_ADDRESS_PER_DAY || lastHour >= RECEIPTS_PER_HOUR) {
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
      // In the fragment, so the token never reaches a server log or a Referer header. The stored
      // snapshot keeps a placeholder: only the token's hash is ever stored.
      continueLink: `${deps.appUrl}/requests/case/${filed.publicRef}#t=${LINK_TOKEN_PLACEHOLDER}`,
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
    // case into "couldn't submit". A receipt that does not go stays as its case_notice row.
    const publicRef = filed.publicRef;
    const sendDeps = deps.sendDeps();
    deps.background(
      sendNotice(Number(notice.id), {
        ...sendDeps,
        from: noticeFrom(def.key, sendDeps.from),
        // One notice, outside any batch: there is no run lock to hold.
        holdsLock: async () => true,
        fillBody: (body) => body.split(LINK_TOKEN_PLACEHOLDER).join(token),
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

/** Something that did not go, on the case's timeline. The reason is a code, never a message. */
const recordEvent = (db: CasesDb, caseId: number, type: string, reason: string) =>
  db
    .insertInto('case_event')
    .values({ case_id: caseId, type, data: JSON.stringify({ reason }) })
    .execute();
const recordUnsent = (db: CasesDb, caseId: number, reason: string) =>
  recordEvent(db, caseId, 'receipt-unsent', reason);

const limitIp = createIntakeRateLimit({ limit: 10, windowMs: 3_600_000 });
// An unresolved ip would put every such caller in one bucket; the main app's limit covers them.
const limitPerIp = (ip: string) => {
  if (ip !== 'unknown') limitIp(ip);
};

export function defaultCaseIntakeDeps(
  more: Pick<CaseIntakeDeps, 'mainDb' | 'appUrl' | 'systemUserId' | 'log'>
): CaseIntakeDeps {
  return {
    db: casesDb(),
    definition: (key) => enabledDefinition(key),
    verifyTurnstile: (token, ip) => verifyTurnstile(token, ip),
    rateLimit: limitPerIp,
    sendDeps: defaultSendDeps,
    alert: async (subject, text) => {
      const to = env.MODERATION_ALERT_EMAIL;
      if (!to)
        throw Object.assign(new Error('MODERATION_ALERT_EMAIL is not set'), {
          name: 'NoAlertAddress',
        });
      await sendEmailStrict({ to, subject, text, html: `<p>${text}</p>` });
    },
    background: (work) =>
      void work.catch((e) => console.error('case receipt send failed', e?.name)),
    ...more,
  };
}
