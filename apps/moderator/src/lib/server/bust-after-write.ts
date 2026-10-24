import { logAxiomError } from './axiom';

/**
 * Runs a cache bust that follows a committed moderation write. Never throws: the write has landed,
 * so a Redis failure here must be logged, not turned into an error page for an action that worked.
 */
export async function bustAfterWrite(name: string, bust: () => Promise<unknown>): Promise<void> {
  try {
    await bust();
  } catch (error) {
    void logAxiomError(error, { name });
  }
}
