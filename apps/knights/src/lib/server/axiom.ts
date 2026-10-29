// Axiom logger for the Knights app via @civitai/axiom, mirroring the moderator app's shim.
//
// `app` is stamped here because it is the only thing separating this app's events from the main app's,
// which share the `civitai-prod` datastream. Spread first so a caller can still override it.
import { createAxiomLogger } from '@civitai/axiom';

const logger = createAxiomLogger();

export function logToAxiom(data: Record<string, unknown>, datastream = 'civitai-prod') {
  return logger.logToAxiom({ app: 'knights', ...data }, datastream);
}
