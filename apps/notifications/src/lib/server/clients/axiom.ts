// Axiom logger via @civitai/axiom — replaces the external notification-server's src/shared.ts (its own
// Axiom Client + logToAxiom/logAxiomError). @civitai/axiom owns the stderr→Loki structured line + the
// Axiom dual-write; this module just binds the `notifications` datastream default and re-exports the
// error helper the worker uses on its catch paths.

import { createAxiomLogger, safeError } from '@civitai/axiom';

const logger = createAxiomLogger();

export function logToAxiom(data: MixedObject, datastream = 'notifications') {
  return logger.logToAxiom(data, datastream);
}

export function logAxiomError(error: unknown) {
  return logToAxiom({ type: 'error', ...safeError(error) }).catch(() => {});
}

export { safeError };
