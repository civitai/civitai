import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { ImportRefusedError } from './backlog-import';
import { caseDataBlocked, casesStoreMessage } from './cases.service';

/**
 * Runs `fn` only while case data may be read and written. Otherwise returns why not: the PII lockdown
 * is open, or the case tables can't be reached. A refusal (`ImportRefusedError`) is not a store
 * failure: it is rethrown for the caller to answer.
 */
export async function withCaseData<T>(
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const blocked = await caseDataBlocked();
    if (blocked) return { ok: false, message: blocked };
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof ImportRefusedError) throw e;
    return { ok: false, message: casesStoreMessage(e) };
  }
}

/** The failure an action returns for an error thrown by the case services. */
export function caseActionFailure(scope: string, e: unknown) {
  if (e instanceof ImportRefusedError) return fail(409, { scope, error: e.message });
  if (e instanceof z.ZodError)
    return fail(400, { scope, error: e.issues[0]?.message ?? 'Invalid file.' });
  return fail(503, { scope, error: casesStoreMessage(e) });
}
