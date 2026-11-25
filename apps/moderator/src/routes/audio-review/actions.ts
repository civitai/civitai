import { fail, type ActionFailure } from '@sveltejs/kit';
import { parseForm } from '$lib/server/query';
import { withheldRefusal } from '$lib/server/retracted-media';
import { violationInputSchema } from '$lib/violations';

/** A refusal for an image withheld from this moderator, named by `key`; null when it is not. */
export async function refuseWithheld(
  user: App.Locals['user'] | undefined,
  imageId: number,
  key: number
) {
  const withheld = await withheldRefusal(user, [imageId]);
  return withheld ? fail(403, { error: withheld, key }) : null;
}

type FailureData<T> = T extends ActionFailure<infer D> ? D : never;

/** A writer's answer named by `key`, so the queue shows a refusal on the row it is about. */
export function keyed<T extends object>(
  result: T,
  key: number
):
  | ActionFailure<FailureData<T> & { key: number }>
  | (Exclude<T, ActionFailure<unknown>> & { key: number }) {
  if ('status' in result) {
    const failure = result as unknown as ActionFailure<FailureData<T>>;
    return fail(failure.status, Object.assign({}, failure.data, { key }));
  }
  return { ...(result as Exclude<T, ActionFailure<unknown>>), key };
}

/** The violation type and note a removal records: the type is required, since the owner is told why. */
export function parseViolation(form: FormData, key: number) {
  const violation = parseForm(violationInputSchema, form);
  if (typeof violation === 'string') return fail(400, { error: violation, key });
  const { violationType, violationDetails } = violation;
  if (!violationType) return fail(400, { error: 'Pick a violation type.', key });
  return { violationType, violationDetails };
}
