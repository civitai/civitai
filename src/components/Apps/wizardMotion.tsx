import { Transition } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import type { ReactNode } from 'react';

/**
 * Subtle fade-in wrapper that respects `prefers-reduced-motion`.
 * When reduced motion is requested the children render immediately without animation.
 */
export function FadeIn({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();

  if (reduced) return <>{children}</>;

  return (
    <Transition mounted transition="fade" duration={300}>
      {(styles) => <div style={styles}>{children}</div>}
    </Transition>
  );
}
