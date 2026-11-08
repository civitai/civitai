import { useEffect, useRef, useState } from 'react';
import { placementRevealDelays } from '~/components/Sticker/placement-order';

/** The whole staggered reveal, however long ago the first hat went on. */
export const HAT_REVEAL_MAX_MS = 1500;
/** With Show hats off, how long the hats stay after placing ends, before they fade. */
export const HAT_PEEK_LINGER_MS = 2000;
/** Matches the `.placed` opacity transition in HatTurfLayer.module.css. */
export const HAT_PEEK_FADE_MS = 400;

type Phase = 'peek' | 'linger' | 'fading' | null;

/**
 * Whether an image's hats are drawn, and when they last arrived together. On with Show hats; with
 * it off, from when the viewer starts placing a hat until a moment after they stop. `revealGen`
 * counts the times the hats appeared all at once, which is what plays the staggered reveal; it
 * stays 0 for hats that were simply there on load.
 */
export function useHatReveal(showHats: boolean, placing: boolean) {
  const [phase, setPhase] = useState<Phase>(null);
  const [revealGen, setRevealGen] = useState(0);
  const phaseRef = useRef<Phase>(null);
  phaseRef.current = phase;
  const shownBefore = useRef(showHats);

  useEffect(() => {
    if (showHats && !shownBefore.current) {
      // Already drawn by a peek, they are on screen: only hats that were hidden play the reveal.
      if (phaseRef.current === null) setRevealGen((gen) => gen + 1);
      setPhase(null);
    }
    shownBefore.current = showHats;
  }, [showHats]);

  useEffect(() => {
    if (showHats) return;
    if (placing) {
      if (phaseRef.current === null) setRevealGen((gen) => gen + 1);
      setPhase('peek');
    } else if (phaseRef.current === 'peek') {
      setPhase('linger');
    }
  }, [placing, showHats]);

  useEffect(() => {
    if (phase !== 'linger' && phase !== 'fading') return;
    const timer = setTimeout(
      () => setPhase(phase === 'linger' ? 'fading' : null),
      phase === 'linger' ? HAT_PEEK_LINGER_MS : HAT_PEEK_FADE_MS
    );
    return () => clearTimeout(timer);
  }, [phase]);

  return { visible: showHats || phase !== null, fading: phase === 'fading', revealGen };
}

/**
 * Each hat's delay in the reveal, oldest first and spaced by the real time between placements,
 * squeezed into HAT_REVEAL_MAX_MS. A hat with no time (or an unreadable one) comes after every timed
 * one, last listed first, since a read lists newest first.
 */
export function hatRevealDelays(hats: { id: unknown; createdAt?: Date | string | null }[]) {
  const times = hats.map((hat) => {
    const at = hat.createdAt ? new Date(hat.createdAt).getTime() : NaN;
    return Number.isFinite(at) ? at : null;
  });
  const latest = Math.max(0, ...times.filter((at): at is number => at !== null));
  const timed = hats.map((hat, index) => ({
    key: String(hat.id),
    // Newest first, so a later index is an earlier hat; a minute apart stands in for the gap.
    at: times[index] ?? latest + (hats.length - index) * 60_000,
  }));
  const ordered = [...timed].sort((a, b) => a.at - b.at);
  const delays = placementRevealDelays(
    ordered.map((hat, id) => ({ id, placedAt: new Date(hat.at) }))
  );
  const last = delays[delays.length - 1] ?? 0;
  const scale = last > HAT_REVEAL_MAX_MS ? HAT_REVEAL_MAX_MS / last : 1;
  return new Map(ordered.map((hat, i) => [hat.key, Math.round(delays[i] * scale)]));
}
