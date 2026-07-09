import { useRef } from 'react';

const WIZARD_STEP_FORM_ID = 'wizard-step-form';

/**
 * Lets a wizard step indicator save the current step's form before navigating.
 *
 * Clicking a step header used to navigate without persisting in-progress form
 * edits. This submits the active step's form (the one carrying `formId`); on a
 * successful save the form's `onSubmit` runs `withSavedNav`, which routes to the
 * clicked step instead of the form's default next-step. A validation failure
 * keeps the user on the step to fix errors, exactly like pressing "Next".
 *
 * `navigate` performs the actual step change (router.replace to the step URL).
 */
export function useWizardStepSave(navigate: (urlStep: number) => void) {
  const pendingStepRef = useRef<number | null>(null);

  const handleStepSelect = (urlStep: number, currentStep: number) => {
    if (urlStep === currentStep) return;
    const form =
      typeof document !== 'undefined'
        ? (document.getElementById(WIZARD_STEP_FORM_ID) as HTMLFormElement | null)
        : null;
    // Steps without an editable form (file upload, post) just navigate.
    if (!form) return navigate(urlStep);
    pendingStepRef.current = urlStep;
    form.requestSubmit();
  };

  function withSavedNav<T>(defaultNav: (result: T) => void) {
    return (result: T) => {
      const target = pendingStepRef.current;
      pendingStepRef.current = null;
      if (target != null) navigate(target);
      else defaultNav(result);
    };
  }

  // Attach to the "Next" button so an explicit Next always uses the form's
  // default navigation, dropping any target left over from a failed step-click.
  const clearPendingStep = () => {
    pendingStepRef.current = null;
  };

  return { formId: WIZARD_STEP_FORM_ID, handleStepSelect, withSavedNav, clearPendingStep };
}
