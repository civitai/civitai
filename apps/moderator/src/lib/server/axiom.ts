// Axiom logger for the moderator app via @civitai/axiom, mirroring apps/auth's shim.
//
// This app had no error path at all: a throw in a load or a form action produced a 500 page for the
// moderator and a stack on pod stdout, which nobody reads. Two of the bugs reported on 2026-08-12
// ("actioning items still causes 500 error, but does action", and the same on deleting an image) could
// not be diagnosed for exactly that reason — the write had already landed, so the symptom was a red page
// with nothing behind it.
//
// @civitai/axiom writes a structured stderr line (→ Alloy → Loki) on every prod call regardless of
// config, and additionally dual-writes to Axiom when AXIOM_TOKEN/AXIOM_ORG_ID are set. Datastream
// defaults to `civitai-prod` so these land alongside the main app and the hub rather than in their own
// dataset.
import { createAxiomLogger, safeError } from '@civitai/axiom';

const logger = createAxiomLogger();

export function logToAxiom(data: Record<string, unknown>, datastream = 'civitai-prod') {
  return logger.logToAxiom(data, datastream);
}

// Fire-and-forget, and swallows its own failure — logging must never be the thing that breaks a request.
//
// `extra` spreads BEFORE safeError so a caller's marker survives and name/message/stack land last. The
// serialized line MUST keep the literal `unhandled server error` substring: the datapacket-talos Loki
// alerts match on it, so rewording the label silently unhooks the alert.
export function logAxiomError(error: unknown, extra?: Record<string, unknown>) {
  return logToAxiom({ type: 'error', ...extra, ...safeError(error) }).catch(() => {});
}

export { safeError };
