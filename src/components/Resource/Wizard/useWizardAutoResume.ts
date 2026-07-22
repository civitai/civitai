import { useEffect, useRef } from 'react';

/**
 * Resumes a draft at its furthest valid step once, on first load.
 *
 * `resolveStep`'s inputs come from queries that get invalidated mid-session (a
 * completed file upload, say); re-resuming on those changes yanks the user
 * forward mid-flow, so this fires exactly once per mount.
 */
export function useWizardAutoResume({
  ready,
  resolveStep,
  onResume,
}: {
  ready: boolean;
  resolveStep: () => number;
  onResume: (targetStep: number) => void;
}) {
  const resumedRef = useRef(false);

  useEffect(() => {
    if (!ready || resumedRef.current) return;
    resumedRef.current = true;
    onResume(resolveStep());
  }, [ready, resolveStep, onResume]);
}
