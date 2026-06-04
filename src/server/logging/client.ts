// App shim for @civitai/axiom. The package owns its env schema (incl. PODNAME and
// LOG_ERRORS_TO_STDOUT), so the app just instantiates the logger and re-exports the
// names existing call sites import from '~/server/logging/client'.
import { createAxiomLogger, safeError } from '@civitai/axiom/client';
import { env } from '~/env/server';

// The build guard is a Next.js concern, so it lives here in the app shim — not in
// the app-agnostic @civitai/axiom package. Skip the client during `next build`.
const noopLog = async (_data: MixedObject, _datastream?: string) => {};

export const logToAxiom = env.IS_BUILD ? noopLog : createAxiomLogger().logToAxiom;
export { safeError };
