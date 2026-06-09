import { Client } from '@axiomhq/axiom-node';
import { loadAxiomEnv, type AxiomConfig } from './env';

/**
 * Extract only safe primitive fields from an error for logging.
 *
 * Logging raw error objects (especially from axios or AWS SDK) blows up the
 * Axiom schema because each unique key in `.config`, `.headers`, `.cause`,
 * `.$metadata`, `.config.data._readableState`, etc. becomes a separate field.
 * Always pass errors through this helper before logging them.
 */
export function safeError(e: unknown): MixedObject | undefined {
  if (e == null) return undefined;
  if (e instanceof Error) {
    const anyErr = e as { code?: unknown; cause?: unknown };
    const cause = anyErr.cause;
    return {
      name: e.name,
      message: e.message,
      stack: e.stack,
      code: anyErr.code,
      causeMessage:
        cause instanceof Error ? cause.message : cause != null ? String(cause) : undefined,
    };
  }
  return { message: String(e) };
}

export type AxiomLogger = {
  logToAxiom: (data: MixedObject, datastream?: string) => Promise<void>;
  safeError: typeof safeError;
};

/**
 * Build an Axiom logger. Config defaults come from the package's own env schema
 * (./env); pass a `Partial<AxiomConfig>` to override any value per call (tests,
 * multi-instance, alternate config sources). Axiom has no injected app-behavior
 * deps (it *is* the logger). See the `~/server/logging/client` shim.
 */
export function createAxiomLogger(overrides: Partial<AxiomConfig> = {}): AxiomLogger {
  const config = { ...loadAxiomEnv(), ...overrides };

  const axiom =
    config.token && config.orgId
      ? new Client({ token: config.token, orgId: config.orgId })
      : null;

  async function logToAxiom(data: MixedObject, datastream?: string) {
    const sendData = { pod: config.podName, ...data };
    if (config.isProd) {
      if (!axiom) return;
      datastream ??= config.datastream;
      if (!datastream) return;

      // Write stderr BEFORE awaiting Axiom — when Axiom is degraded,
      // ingestEvents rejects and the rest of this function never runs.
      // Loki ingest depends on the stderr line; without this ordering,
      // the Grafana alerts that consume `{ "name": "sysredis-fail-open",
      // ... }` go silent during the exact multi-service incident class
      // they exist to handle (sysRedis + Axiom both down).
      if (config.logErrorsToStdout)
        console.error(JSON.stringify({ _axiom: datastream, ...sendData }));

      await axiom.ingestEvents(datastream, sendData);
    } else {
      console.log('logToAxiom', sendData);
    }
  }

  return { logToAxiom, safeError };
}
