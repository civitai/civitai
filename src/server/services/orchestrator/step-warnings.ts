import type { WorkflowStepWarning } from '@civitai/orchestration-client';

// The pinned @civitai/orchestration-client types predate step warnings, so steps are read structurally.
type StepWithWarnings = { warnings?: WorkflowStepWarning[] | null };

// The generator still sends the orchestrator's old input field names, so every step carries these;
// they are for the app's developers, not the user.
const HIDDEN_CODES = new Set(['fieldDeprecated']);

/** Step warnings across a workflow, one per distinct code + message. */
export function collectStepWarnings(steps: readonly unknown[] | null | undefined) {
  const byKey = new Map<string, WorkflowStepWarning>();
  for (const step of steps ?? []) {
    const warnings = (step as StepWithWarnings | null)?.warnings;
    // A banner is not worth failing the estimate over, and a rejected whatIf disables submit.
    if (!Array.isArray(warnings)) continue;
    for (const warning of warnings) {
      if (typeof warning?.code !== 'string' || typeof warning?.message !== 'string') continue;
      if (HIDDEN_CODES.has(warning.code)) continue;
      const key = `${warning.code}:${warning.message}`;
      if (!byKey.has(key)) byKey.set(key, warning);
    }
  }
  return [...byKey.values()];
}
