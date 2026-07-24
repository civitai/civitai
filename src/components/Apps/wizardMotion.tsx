import { Transition, type MantineTransition } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { useEffect, useState, type ReactNode } from 'react';

/**
 * App Store Listings (W13) — the external submit/edit wizard's SUBTLE motion
 * primitive. A mount-triggered fade/slide that plays once when the wrapped content
 * first appears (a fresh step body, the "we found your details" autofill reveal, a
 * sensitive-scope input group). Reuses the repo's EXISTING animation stack —
 * Mantine `Transition` + the `useReducedMotion` hook — so no new dependency is
 * added.
 *
 * 🔴 Respects `prefers-reduced-motion`: when the viewer opts out, the children are
 * rendered directly with NO wrapper and NO animation (Mantine's `Transition` also
 * honours the provider's `respectReducedMotion`, but short-circuiting here keeps
 * the reduced-motion DOM identical to a plain render and cheap to assert).
 *
 * The fade is keyed on FIRST MOUNT: because the wizard's `Stepper` renders only the
 * ACTIVE step's children, wrapping each step body remounts this on every step
 * change, so the enter transition replays as the author advances/goes back.
 */
export function FadeIn({
  children,
  transition = 'fade',
  duration = 200,
  'data-testid': testId,
}: {
  children: ReactNode;
  transition?: MantineTransition;
  duration?: number;
  'data-testid'?: string;
}) {
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(false);

  // Flip false→true after mount so `Transition` plays its ENTER animation (a
  // Transition that starts `mounted` never animates its first appearance).
  useEffect(() => {
    setMounted(true);
  }, []);

  if (reduceMotion) {
    return <div data-testid={testId}>{children}</div>;
  }

  return (
    <Transition mounted={mounted} transition={transition} duration={duration} timingFunction="ease">
      {(styles) => (
        <div style={styles} data-testid={testId}>
          {children}
        </div>
      )}
    </Transition>
  );
}
