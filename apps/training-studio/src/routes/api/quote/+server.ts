import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { trainingWhatIf } from '$lib/server/orchestrator';
import type { TrainingWhatIfInput } from '$lib/orchestrator-core';

const optionalString = (v: unknown) => v === undefined || typeof v === 'string';
const optionalNumber = (v: unknown) =>
  v === undefined || (typeof v === 'number' && Number.isFinite(v) && v > 0);

// Price one run's exact config without submitting it (whatif) — the Review step's Final price.
export const POST: RequestHandler = async ({ locals, request }) => {
  const token = await requireToken(locals, 'Pricing is unavailable right now — no orchestrator token.');

  const body = (await request.json().catch(() => null)) as Partial<TrainingWhatIfInput> | null;
  if (
    !body ||
    typeof body.ecosystem !== 'string' ||
    !body.ecosystem ||
    !optionalString(body.model) ||
    !optionalString(body.modelVariant) ||
    !optionalString(body.version) ||
    !optionalString(body.engine) ||
    !optionalNumber(body.steps) ||
    !optionalNumber(body.epochs) ||
    !optionalNumber(body.imageCount)
  ) {
    error(400, 'Bad quote request.');
  }

  try {
    return json({ cost: await trainingWhatIf(token, body as TrainingWhatIfInput) });
  } catch (err) {
    console.warn('[training-studio] quote whatif failed', err);
    // Null, not a 5xx: an unpriceable config renders as "—" and blocks Start the same way the
    // from-quote path does — the client treats transport errors and unpriced identically.
    return json({ cost: null });
  }
};
