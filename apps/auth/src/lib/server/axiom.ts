// Axiom logger for the auth hub via @civitai/axiom. The hub had no Axiom path, so its captcha/auth telemetry
// was invisible outside the cluster (ClickUp 868k9gug8). @civitai/axiom writes a structured stderr line
// (→ Alloy → Loki) on every prod call regardless of config, and additionally dual-writes to Axiom when
// AXIOM_TOKEN/AXIOM_ORG_ID are set. Default the datastream to `civitai-prod` so hub events are queryable
// alongside the main app's `auth-flow` logs rather than in a separate dataset.
import { createAxiomLogger, safeError } from '@civitai/axiom';

const logger = createAxiomLogger();

export function logToAxiom(data: Record<string, unknown>, datastream = 'civitai-prod') {
  return logger.logToAxiom(data, datastream);
}

export { safeError };
