import { useEffect, useRef } from 'react';

/**
 * Resumes an existing draft at its furthest valid step ONCE, on first load.
 *
 * The resume inputs (has-a-version, has-files) are derived from queries that get
 * invalidated mid-session — notably when a file upload completes. Re-running the
 * resume on those changes yanks the user forward while their other files are
 * still transferring, so forward navigation stays user-driven (Next button or a
 * reachable step indicator) after this fires.
 */
export function useWizardAutoResume({
  ready,
  resolveStep,
  onResume,
}: {
  ready: boolean;
  resolveStep: () => number;
  onResume: (step: number) => void;
}) {
  const resumedRef = useRef(false);
  const resolveStepRef = useRef(resolveStep);
  const onResumeRef = useRef(onResume);
  resolveStepRef.current = resolveStep;
  onResumeRef.current = onResume;

  useEffect(() => {
    if (!ready || resumedRef.current) return;
    resumedRef.current = true;
    onResumeRef.current(resolveStepRef.current());
  }, [ready]);
}
