// Axiom logger for the Training Studio via @civitai/axiom, mirroring apps/moderator's shim. Pod stdout is
// not shipped to Axiom, so anything support needs to look up must go through here.
import { createAxiomLogger, safeError } from '@civitai/axiom';

const logger = createAxiomLogger();

type LogData = Record<string, unknown>;

// `app` separates these events from the main app's in the shared datastream. The datastream is a literal
// so the root axiom-datastream-ledger test can check it is provisioned.
export function logToAxiom(data: LogData) {
  return logger.logToAxiom({ app: 'training-studio', ...data }, 'civitai-prod').catch(() => {});
}

export { safeError };
