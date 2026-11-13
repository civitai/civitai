/**
 * Daily email while any owner's hold is ending. No dedupe, so an ignored alert repeats.
 * The message carries a count, a date and a link, never an id: it leaves our systems.
 */

import {
  countEvidenceHoldsEnding,
  EVIDENCE_HOLD_ENDING_DAYS,
} from '@civitai/db-queries/evidence-hold';
import { env } from '~/env/server';
import { kyselyRead } from '~/server/db/kyselyDb';
import { isEmailConfigured, sendEmail } from '~/server/email/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';

const NAME = 'evidence-hold-expiry-alert';

async function alertEndingEvidenceHolds() {
  const { owners, earliest } = await countEvidenceHoldsEnding(kyselyRead);
  // `stringToArray` turns a set-but-empty variable into `['']`.
  const recipients = env.EVIDENCE_HOLD_ALERT_EMAILS.filter(Boolean);

  await logToAxiom({
    type: 'info',
    name: NAME,
    message: `${owners} owner(s) with an evidence hold ending within ${EVIDENCE_HOLD_ENDING_DAYS} days`,
    owners,
    earliest: earliest?.toISOString() ?? null,
  }).catch(() => null);

  // Every run, not only when something is ending: an alert with nowhere to go must be noticed before
  // the day it is needed.
  const unsendable = !recipients.length
    ? 'EVIDENCE_HOLD_ALERT_EMAILS is not set'
    : !isEmailConfigured()
    ? 'email is not configured'
    : null;
  if (unsendable) {
    await logToAxiom({
      type: 'error',
      name: NAME,
      message: `Evidence hold expiry alert cannot be sent: ${unsendable}`,
      owners,
    }).catch(() => null);
    return { owners, sent: false };
  }

  if (!owners) return { owners, sent: false };

  const date = earliest?.toISOString().slice(0, 10) ?? 'unknown';
  const link = `${env.MODERATOR_APP_URL}/evidence-holds`;
  const summary =
    `${owners} owner(s) with an evidence hold ending within ${EVIDENCE_HOLD_ENDING_DAYS} days, ` +
    `the earliest on ${date} (UTC).`;
  await sendEmail({
    to: recipients,
    subject: `Evidence holds ending soon: ${owners}`,
    html: `<p>${summary}</p><p>Review: <a href="${link}">${link}</a></p>`,
    text: `${summary}\n\nReview: ${link}`,
  });
  return { owners, sent: true };
}

export const evidenceHoldExpiryAlertJob = createJob(NAME, '0 9 * * *', alertEndingEvidenceHolds);
