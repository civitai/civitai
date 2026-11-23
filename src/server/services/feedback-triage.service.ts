import {
  feedbackTriageResponse,
  type FeedbackTriageInput,
  type FeedbackTriageRequest,
} from '@civitai/moderation';
import { moderatorApp } from '~/server/services/moderator-app.service';

/**
 * The main app's one door to the moderator queue's triage write (`triageFeedback`, reached over the
 * `feedback-triage` mod-action). The moderator API endpoint and the HQ status sync both come
 * through here, so the spoke's answer is read in one place.
 *
 *   changed  — the row now holds the requested status (and note/link).
 *   conflict — the row was no longer at `expectedStatus`; nothing was written.
 *   gone     — no such row.
 *
 * Anything else the spoke answers throws: a reply this cannot read is not a success.
 */
export type FeedbackTriageOutcome = 'changed' | 'conflict' | 'gone';

export async function setFeedbackTriage(
  input: FeedbackTriageRequest & {
    actorId: number;
    expectedHandledById?: number | null;
    expectedUnheld?: boolean;
  },
  send: (input: FeedbackTriageInput) => Promise<unknown> = (i) => moderatorApp.feedbackTriage(i)
): Promise<FeedbackTriageOutcome> {
  const { actorId, ...request } = input;
  const parsed = feedbackTriageResponse.safeParse(await send({ ...request, userId: actorId }));
  if (!parsed.success) throw new Error('feedback-triage: unreadable answer from the moderator app');
  const { result } = parsed.data;
  if (result.ok) return result.changed ? 'changed' : 'conflict';
  if (result.reason === 'gone') return 'gone';
  throw new Error(`feedback-triage: refused (${result.reason})`);
}
