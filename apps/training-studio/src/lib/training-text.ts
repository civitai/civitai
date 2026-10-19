// Kept apart from train-core so a route can name the refusal without loading the orchestrator client.

/** The main app's training text rule refused a run's trigger word or captions; the message says why. */
export class TrainingTextRefusedError extends Error {}

/** The check could not give a verdict. `status` is the main app's answer, when there was one: a 403
 *  or 413 will not change on retry, a 429 will later. */
export class TrainingTextCheckError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** The status to answer a failed check with: the main app's own when a retry will not help now. */
export function textCheckFailureStatus(err: TrainingTextCheckError): number {
  return err.status === 403 || err.status === 413 || err.status === 429 ? err.status : 502;
}

/** Runs the main app's training text rule over one run. Throws `TrainingTextRefusedError` on a
 *  refusal, and any other error when the check could not run, so nothing is submitted unchecked. */
export type TrainingTextCheck = (input: {
  triggerWord: string;
  captions: string[];
}) => Promise<void>;
