import { chunk } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import {
  isFliptFlagReadable,
  isFliptOnForTesters,
  isFliptPublic,
} from '~/server/flipt/tester-segment';
import type { FeatureFlagKey } from '~/server/services/feature-flags.service';
import { getFeatureFliptKey } from '~/server/services/feature-flags.service';

/**
 * Who can see and play an event. An event with a `featureFlag` is behind that Flipt flag
 * (moderators plus a testers rollout, base off until launch):
 *
 * - from `previewFrom` until `startDate`, users the flag is on for play it early, so the whole
 *   system can be tested before launch. Turning the base on before the start ARMS the launch: the
 *   preview closes for everyone, and the event opens to all at `startDate` with no deploy.
 * - from `startDate` until `endDate`, it is open to everyone the flag is on for, which is everyone
 *   once the base is on. Turning the base off is the kill switch.
 * - after `endDate`, the same people can still read it (results), but nobody can play.
 *
 * An event without a flag is open on its dates alone.
 */
export type EventAccess = 'closed' | 'preview' | 'open' | 'ended';

export type GatedEvent = {
  name: string;
  startDate: Date;
  endDate: Date;
  featureFlag?: FeatureFlagKey;
  previewFrom?: Date;
};

export type EventViewer = { id?: number; isModerator?: boolean } | null | undefined;

/** Readable: the event page, standings and scores. */
export const canReadEvent = (access: EventAccess) => access !== 'closed';
/** Playable: join, buy, place, and see its decorations on content. */
export const canPlayEvent = (access: EventAccess) => access === 'preview' || access === 'open';

function fliptKeyOf(event: GatedEvent) {
  if (!event.featureFlag) return undefined;
  const key = getFeatureFliptKey(event.featureFlag);
  if (!key) throw new Error(`Feature flag ${event.featureFlag} has no Flipt key`);
  return key;
}

// A signed-out viewer is in no segment, so only a public flag lets them in.
function isFlagOnFor(fliptKey: string, viewer: EventViewer) {
  return viewer?.id || viewer?.isModerator
    ? isFliptOnForTesters(fliptKey, viewer)
    : isFliptPublic(fliptKey);
}

export async function getEventAccess(
  event: GatedEvent,
  viewer: EventViewer,
  now = new Date()
): Promise<EventAccess> {
  const fliptKey = fliptKeyOf(event);
  if (!fliptKey) {
    if (now < event.startDate) return 'closed';
    return now < event.endDate ? 'open' : 'ended';
  }

  const inPreview = !!event.previewFrom && now >= event.previewFrom && now < event.startDate;
  if (now < event.startDate && !inPreview) return 'closed';
  if (!(await isFlagOnFor(fliptKey, viewer))) return 'closed';
  if (now >= event.endDate) return 'ended';
  if (now >= event.startDate) return 'open';
  // Armed: the base is on before the start, so nobody plays until it opens for everyone.
  return (await isFliptPublic(fliptKey)) ? 'closed' : 'preview';
}

/**
 * What the background jobs score at `now`: the window, and whether only users the flag is on for
 * count. Null when nothing should be scored. Throws when the flag cannot be read, because a
 * filtered run that should not have been would zero everyone else's scores for that day.
 */
export async function getEventScoringPhase(event: GatedEvent, now = new Date()) {
  const fliptKey = fliptKeyOf(event);
  if (!fliptKey) {
    if (now < event.startDate) return null;
    return { from: event.startDate, to: event.endDate, fliptKey: undefined };
  }

  if (!(await isFliptFlagReadable(fliptKey)))
    throw new Error(`Flag ${fliptKey} is unreadable; not scoring ${event.name}`);
  const isPublic = await isFliptPublic(fliptKey);

  if (now >= event.startDate)
    return {
      from: event.startDate,
      to: event.endDate,
      fliptKey: isPublic ? undefined : fliptKey,
    };
  const inPreview = !!event.previewFrom && now >= event.previewFrom;
  if (!inPreview || isPublic) return null;
  return { from: event.previewFrom as Date, to: event.startDate, fliptKey };
}

export type EventScoringPhase = NonNullable<Awaited<ReturnType<typeof getEventScoringPhase>>>;

/** Of `userIds`, those the flag is on for. Flipt evaluates in process, so each check is cheap. */
export async function flagAudienceAmong(fliptKey: string, userIds: number[]) {
  const audience = new Set<number>();
  if (!userIds.length) return audience;
  const users = await dbWrite.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, isModerator: true },
  });
  for (const batch of chunk(users, 1000)) {
    const on = await Promise.all(
      batch.map((u) => isFliptOnForTesters(fliptKey, { id: u.id, isModerator: !!u.isModerator }))
    );
    batch.forEach((u, i) => on[i] && audience.add(u.id));
  }
  return audience;
}
