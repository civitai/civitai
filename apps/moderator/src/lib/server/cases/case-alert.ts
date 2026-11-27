import { sendEmailStrict } from '@civitai/email';
import { env } from '$env/dynamic/private';

/** The moderation alert inbox, shared by intake and the tick. */
export async function caseAlert(subject: string, text: string, template: string) {
  const to = env.MODERATION_ALERT_EMAIL;
  if (!to)
    throw Object.assign(new Error('MODERATION_ALERT_EMAIL is not set'), { name: 'NoAlertAddress' });
  await sendEmailStrict({
    to,
    subject,
    text,
    html: `<pre>${text.replace(
      /[&<>]/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]!)
    )}</pre>`,
    tags: { template, mailClass: 'transactional' },
  });
}
