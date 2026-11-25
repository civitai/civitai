import { DIGEST_EMAIL_TEMPLATE } from '~/server/notifications/digest-tracking';
import { MISSED_DIGEST_EMAIL_TYPE } from '~/server/notifications/missed-digest.constants';

/**
 * Each lifecycle email's own opt-out: the `UserEmailNotificationOptOut` type its unsubscribe link
 * turns off, and the template key its emailEvents rows carry. A lifecycle template declares its type
 * (`optOut` in base.email.ts); the template ledger test pins that every lifecycle template has an
 * entry here and every entry is a lifecycle template's. An opt-out through the unsubscribe link of a
 * type listed here is an emailEvents `unsubscribe` row.
 */
export const LIFECYCLE_EMAIL_OPT_OUTS: Readonly<Record<string, string>> = {
  [MISSED_DIGEST_EMAIL_TYPE]: DIGEST_EMAIL_TEMPLATE,
};

export const lifecycleTemplateForOptOut = (type: string): string | undefined =>
  Object.hasOwn(LIFECYCLE_EMAIL_OPT_OUTS, type) ? LIFECYCLE_EMAIL_OPT_OUTS[type] : undefined;
