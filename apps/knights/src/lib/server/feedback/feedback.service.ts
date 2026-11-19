import type { Kysely } from 'kysely';
import {
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_PATH_MAX_LENGTH,
  FEEDBACK_RATE_LIMIT,
} from '@civitai/shared/feedback.constants';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';

const AREA = 'knights';
const USER_AGENT_MAX_LENGTH = 200;

export type FeedbackContext = { path?: string; userAgent?: string; rank?: string; level?: number };

/** `path` is client-supplied: keep it only if same-origin (truncated), otherwise drop it rather than reject the report. */
export function feedbackContext(input: {
  path: string | null;
  userAgent: string | null;
  status: { rank: string; level: number } | null;
}): FeedbackContext {
  const context: FeedbackContext = {};
  if (input.path?.startsWith('/') && !input.path.startsWith('//')) {
    context.path = input.path.slice(0, FEEDBACK_PATH_MAX_LENGTH);
  }
  if (input.userAgent) context.userAgent = input.userAgent.slice(0, USER_AGENT_MAX_LENGTH);
  if (input.status) {
    context.rank = input.status.rank;
    context.level = input.status.level;
  }
  return context;
}

export type SubmitFeedbackResult = { ok: true } | { ok: false; reason: 'invalid' | 'rate-limited' };

/** Applies the site's message bound and hourly cap itself (same constants, counted over this user's `knights` rows). */
export async function submitFeedback(
  db: Kysely<DB>,
  input: { userId: number; message: unknown; context: FeedbackContext; now: Date }
): Promise<SubmitFeedbackResult> {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (message.length < 1 || message.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
    return { ok: false, reason: 'invalid' };
  }

  const since = new Date(input.now.getTime() - FEEDBACK_RATE_LIMIT.periodSeconds * 1000);
  const { count } = await db
    .selectFrom('Feedback')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('userId', '=', input.userId)
    .where('area', '=', AREA)
    .where('createdAt', '>=', utc(since))
    .executeTakeFirstOrThrow();
  if (Number(count) >= FEEDBACK_RATE_LIMIT.max) return { ok: false, reason: 'rate-limited' };

  await db
    .insertInto('Feedback')
    .values({
      userId: input.userId,
      area: AREA,
      message,
      context: JSON.stringify(input.context),
      createdAt: utc(input.now),
    })
    .execute();
  return { ok: true };
}
