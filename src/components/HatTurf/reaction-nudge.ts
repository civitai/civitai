import clsx from 'clsx';
import { create } from 'zustand';
import { useReactionsStore } from '~/components/Reaction/ReactionButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useShowEventCosmetics } from '~/providers/BrowserSettingsProvider';
import classes from './reaction-nudge.module.css';

// Two pulses of the ring (reaction-nudge.module.css), or a static ring for as long under reduced motion.
export const REACTION_NUDGE_MS = 2_400;
// A server follows turf map changes at most every 2s (HATS_FOLLOW_MS in points/award.ts) and scores a
// reaction on the map it holds: the nudge waits that long before asking whether a reaction earns. An
// idle server can still be behind; a busy one has followed by then.
export const REACTION_NUDGE_DELAY_MS = 2_000;
const SESSION_KEY = 'hatTurfReactionNudged';

// The images this tab has nudged on. Read and written in try/catch: storage can be unavailable.
function takeOnce(imageId: number) {
  try {
    const seen = new Set<number>(JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? '[]'));
    if (seen.has(imageId)) return false;
    seen.add(imageId);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify([...seen]));
  } catch {
    // Without storage, the in-memory store still keeps it to one nudge per placement.
  }
  return true;
}

const useNudgeStore = create<{ armed: Record<number, string> }>(() => ({ armed: {} }));

/**
 * After a placement, once servers have had time to follow the map it changed, asks `earns` whether
 * the placer reacting to the image would pay their team; if so its reaction bar glows in that team's
 * colour. Once per image per session.
 */
export function armReactionNudge(imageId: number, team: string, earns: () => Promise<boolean>) {
  if (!takeOnce(imageId)) return;
  setTimeout(() => {
    // Only the nudge rides on the answer: a failed ask shows nothing.
    Promise.resolve()
      .then(earns)
      .then((yes) => {
        if (!yes) return;
        useNudgeStore.setState((s) => ({ armed: { ...s.armed, [imageId]: team } }));
        setTimeout(() => {
          useNudgeStore.setState((s) => {
            const { [imageId]: _, ...armed } = s.armed;
            return { armed };
          });
        }, REACTION_NUDGE_MS);
      })
      .catch(() => undefined);
  }, REACTION_NUDGE_DELAY_MS);
}

/**
 * The class that glows an image's reaction bar while it is nudged: never on the viewer's own image,
 * once they have reacted to it, or with event cosmetics off.
 */
export function useReactionNudgeClass({
  imageId,
  ownerId,
  reactions,
}: {
  imageId: number;
  ownerId: number;
  reactions?: { userId: number; reaction: string }[];
}) {
  const team = useNudgeStore((s) => s.armed[imageId]);
  const user = useCurrentUser();
  const showCosmetics = useShowEventCosmetics();
  const stored = useReactionsStore({ entityType: 'image', entityId: imageId });
  if (!team || !showCosmetics || !user || user.id === ownerId) return undefined;
  // A reaction toggled in this tab is in the store; one from before, in the image's own row.
  const reacted =
    Object.values(stored).some(Boolean) ||
    (reactions ?? []).some((r) => r.userId === user.id && stored[r.reaction] !== false);
  if (reacted) return undefined;
  return clsx(classes.nudge, classes[team.toLowerCase()]);
}
