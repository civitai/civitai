import { asOrdinal } from '~/utils/number-helpers';

/**
 * The note sent with a personal-data export, and the archive's README. The wording is the approved
 * template: change it only with the same sign-off. `{username}`, `{link}` and `{taken_at}` are filled
 * by `fillCoverNote`.
 *
 * Signed off by Legal: the template as first approved, and on November 7th, 2026 the sentence on
 * parts that could not be included ("If any part could not be included...").
 */
export const COVER_NOTE_SUBJECT = 'Your Civitai data (access request)';

export const COVER_NOTE_TEMPLATE = `Hi {username},

Here is a copy of the personal data Civitai holds about your account, as you requested. The download link works for 48 hours: {link}

**What's in it.** Your account and profile, sign-in records (dates, IP addresses, devices), subscriptions, purchases and Buzz transactions, the content you created (images, videos, models, articles, posts, comments, reactions, collections), your generation history (prompts, settings, resources, job dates), reports you filed, and moderation decisions about your account. Media is listed with links rather than attached. Activity data is summarized as counts; ask us if you'd like the raw events. A manifest lists every file and how many records it contains. Data is as of {taken_at}. If any part could not be included in this archive, the manifest says so and why. If you would like us to look into it further, reply to this message.

**What's left out, and why.** Passwords, security tokens and keys. Other people's personal data, such as the identity of anyone who reported content. Details of our safety systems that would help someone get around them, such as scores and thresholds.

**Why we use your data.** To run Civitai and your account; to process payments and creator payouts; to keep the platform safe (including automated checks of content and prompts, with human review of decisions that restrict an account); to meet our legal obligations; and, where you've agreed, for optional features and communications.

**Who receives it.** Service providers who process data for us (for example hosting, payments, payouts, email, and AI model providers that run generations), and authorities where the law requires it, including reports of child sexual abuse material.

**Where it's processed.** Civitai is based in the United States, and your data is processed there.

**How long we keep it.** For as long as your account is active, and afterwards only as needed for legal, safety, tax or dispute purposes. Generation records are kept for a shorter time.

**Where it comes from.** From you, and from our own systems as you use Civitai.

**Your rights.** You can ask us to correct, delete or restrict your data, object to some uses, or take your data elsewhere, by writing to compliance@civitai.com. You can also complain to a data protection authority in your country.

Civitai Support`;

/** What the archive's own copy says where the email has the link. */
export const README_LINK_TEXT = '(the link in the email this archive came with)';

/** "November 6th, 2026 at 3:15 PM UTC": American English, as the note is. */
export function formatTakenAt(date: Date): string {
  const month = date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const time = date.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${month} ${asOrdinal(date.getUTCDate())}, ${date.getUTCFullYear()} at ${time} UTC`;
}

/** The note with its placeholders filled. Values are inserted literally (no `$` patterns). */
export function fillCoverNote(v: { username: string; link: string; takenAt: Date }): string {
  return COVER_NOTE_TEMPLATE.replace(/\{username\}/g, () => v.username)
    .replace(/\{link\}/g, () => v.link)
    .replace(/\{taken_at\}/g, () => formatTakenAt(v.takenAt));
}
