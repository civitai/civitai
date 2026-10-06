import { fail } from '@sveltejs/kit';

/** A refusal the lab explains to the moderator, with the HTTP status the form fails with. */
export class LabError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = new.target.name;
  }
}

/** A lab refusal goes back to the form; anything else is a real error. */
export function refused(e: unknown) {
  if (e instanceof LabError) return fail(e.status, { error: e.message });
  throw e;
}
