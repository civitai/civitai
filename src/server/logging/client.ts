import { Client } from '@axiomhq/axiom-node';
import { isProd } from '~/env/other';
import { env } from '~/env/server';

const shouldConnect = !env.IS_BUILD && env.AXIOM_TOKEN && env.AXIOM_ORG_ID;
const axiom = shouldConnect
  ? new Client({
      token: env.AXIOM_TOKEN,
      orgId: env.AXIOM_ORG_ID,
    })
  : null;

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

export async function logToAxiom(data: MixedObject, datastream?: string) {
  const sendData = { pod: env.PODNAME, ...data };
  if (isProd) {
    if (!axiom) return;
    datastream ??= env.AXIOM_DATASTREAM;
    if (!datastream) return;

    await axiom.ingestEvents(datastream, sendData);
    if (process.env.LOG_ERRORS_TO_STDOUT === 'true')
      console.error(JSON.stringify({ _axiom: datastream, ...sendData }));
  } else {
    console.log('logToAxiom', sendData);
  }
}
