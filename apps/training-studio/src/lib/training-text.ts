// Kept apart from train-core so a route can name the refusal without loading the orchestrator client.

/** The main app's trigger word check refused a run's trigger word; the message says why. */
export class TrainingTextRefusedError extends Error {}

/** The check could not give a verdict. `status` is the main app's answer, when there was one: a 401
 *  or 403 will not change on retry. */
export class TrainingTextCheckError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** The status to answer a failed check with: the main app's own when a retry will not help now. */
export function textCheckFailureStatus(err: TrainingTextCheckError): number {
  return err.status === 401 || err.status === 403 ? err.status : 502;
}

/** Runs the main app's trigger word check over one run. Throws `TrainingTextRefusedError` on a
 *  refusal, and any other error when the check could not run, so nothing is submitted unchecked. */
export type TrainingTextCheck = (input: { triggerWord: string }) => Promise<void>;
