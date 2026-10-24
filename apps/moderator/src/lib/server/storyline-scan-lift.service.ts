import { recordModActivity } from './mod-activity';
import { callModEndpoint } from './user-actions.service';

/**
 * Lifts the title scan's takedown through the main app, which owns the scan's record of a lifted
 * title (so a rescan of it does not take it down again) and refuses a title edited since
 * `reviewedTitle` was read. A moderator's own takedown is not lifted, and keeps the storyline down.
 */
export async function liftStorylineScanTakedown({
  storylineId,
  reviewedTitle,
  moderatorId,
}: {
  storylineId: number;
  reviewedTitle: string;
  moderatorId: number;
}): Promise<{ ok: true; tosViolation: boolean } | { ok: false; error: string }> {
  const result = await callModEndpoint(
    'storyline/lift-title-takedown',
    { storylineId, reviewedTitle },
    'Lift takedown'
  );
  if (!result.ok) {
    // A timeout, dropped socket or server error may come after the main app lifted it.
    const mayHaveLifted = !result.requestNeverSent && (result.status ?? 500) >= 500;
    return {
      ok: false,
      error: mayHaveLifted
        ? 'The lift did not get an answer and may have gone through. Reload to check before lifting again.'
        : result.error,
    };
  }
  await recordModActivity({
    userId: moderatorId,
    entityType: 'storyline',
    entityId: storylineId,
    activity: 'lift',
  });
  return { ok: true, tosViolation: result.body.tosViolation === true };
}
