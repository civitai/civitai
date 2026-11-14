// `app` is the only field separating Knights events from the main app's in the shared `civitai-prod` datastream.
// Spread first so a caller can still override it.
import { createAxiomLogger } from '@civitai/axiom';

const logger = createAxiomLogger();

export function logToAxiom(data: Record<string, unknown>, datastream = 'civitai-prod') {
  return logger.logToAxiom({ app: 'knights', ...data }, datastream);
}
