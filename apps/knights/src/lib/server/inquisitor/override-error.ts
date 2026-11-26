/**
 * Why writing the moderators' level through the main app failed. `ambiguous`: no answer (a timeout, a dropped connection, a
 * server error), so the level may have been written; otherwise the main app refused it and nothing was written.
 */
export class OverrideWriteError extends Error {
  constructor(message: string, readonly ambiguous: boolean) {
    super(message);
    this.name = 'OverrideWriteError';
  }
}
