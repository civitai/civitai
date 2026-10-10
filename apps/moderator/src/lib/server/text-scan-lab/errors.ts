import { fail } from '@sveltejs/kit';

export class LabError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = new.target.name;
  }
}

export function refused(e: unknown) {
  if (e instanceof LabError) return fail(e.status, { error: e.message });
  throw e;
}
