import Router from 'next/router';
import { getFaroSessionId } from '~/utils/faro/getFaroSessionId';
import {
  readConsoleErrors,
  readNetworkErrors,
  readTrpcErrors,
} from '~/utils/feedback/browserErrorLog';
import { collectClientContext } from '~/utils/feedback/clientContext';

function currentRoute(): string | undefined {
  try {
    return Router.pathname || undefined;
  } catch {
    // No router instance (a test, or a surface rendered outside the app).
    return undefined;
  }
}

/**
 * Everything a report attaches on its own, beyond what the reporter typed or chose. The submit and
 * the "Details we attach" preview both call this, so the preview shows the same object that is
 * sent. Read at call time: Faro may start, and errors may arrive, while the panel is open.
 *
 * The buffers are already redacted and bounded by their recorder. An empty array is OMITTED: an
 * absent key reads as "no claim", `[]` would read as "we looked and found nothing".
 */
export function readAttachedDiagnostics() {
  const sessionId = getFaroSessionId();
  const consoleErrors = readConsoleErrors();
  const networkErrors = readNetworkErrors();
  const trpcErrors = readTrpcErrors();
  return {
    ...collectClientContext({ route: currentRoute() }),
    ...(sessionId ? { sessionId } : {}),
    ...(consoleErrors.length ? { consoleErrors } : {}),
    ...(networkErrors.length ? { networkErrors } : {}),
    ...(trpcErrors.length ? { trpcErrors } : {}),
  };
}

export type AttachedDiagnostics = ReturnType<typeof readAttachedDiagnostics>;
