import { createAxiomLogger, type AxiomLogger } from '@civitai/axiom';

// Cached on globalThis so dev HMR reuses one client instead of leaking one per reload, and a build/prerender
// import never eagerly constructs it.
const globalForLogger = globalThis as unknown as { axiomLogger?: AxiomLogger };

export function getLogger(): AxiomLogger {
  if (!globalForLogger.axiomLogger) {
    globalForLogger.axiomLogger = createAxiomLogger();
  }
  return globalForLogger.axiomLogger;
}
