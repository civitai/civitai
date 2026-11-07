import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { feedbackEnabled } from '$lib/server/feedback/enabled';
import { feedbackContext, submitFeedback } from '$lib/server/feedback/feedback.service';
import { getPlayerStatus } from '$lib/server/player-status';
import { queueDeps } from '$lib/server/queue/runtime';
import { MUTED_MESSAGE, getStanding } from '$lib/server/standing';
import type { RequestHandler } from './$types';

const refuse = (status: number, message: string) => json({ ok: false, message }, { status });

const REFUSALS = {
  invalid: { status: 400, message: 'Write a message of up to 2,000 characters.' },
  'rate-limited': {
    status: 429,
    message: 'You have sent a lot of feedback lately. Try again later.',
  },
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!(await feedbackEnabled(locals.user))) return refuse(403, 'Feedback is not open yet.');
  if ((await getStanding(db, locals.user.id)).muted) return refuse(403, MUTED_MESSAGE);
  const form = await request.formData();
  const path = form.get('path');

  // The rank and level only enrich the report; a failed read must not lose it.
  const status = await getPlayerStatus(db, locals.user.id).catch((error) => {
    console.warn('knights: could not read the player status for feedback', { error });
    return null;
  });
  const context = feedbackContext({
    path: typeof path === 'string' ? path : null,
    userAgent: request.headers.get('user-agent'),
    status,
  });

  try {
    const result = await submitFeedback(db, {
      userId: locals.user.id,
      message: form.get('message'),
      context,
      now: queueDeps.now(),
    });
    if (result.ok) return json({ ok: true });
    return refuse(REFUSALS[result.reason].status, REFUSALS[result.reason].message);
  } catch (error) {
    console.error('knights: feedback could not be saved', { error });
    return refuse(500, 'Your feedback could not be sent. Try again in a moment.');
  }
};
