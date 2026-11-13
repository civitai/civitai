import { timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { blockBearerToken } from '~/server/utils/block-bearer';
import {
  applyGameFrameState,
  fileGameFrameReport,
  gameFrameReportSchema,
  gameFrameSlugSchema,
  gameFrameStateSchema,
} from '~/server/services/game-frame-report.service';

const MIN_TOKEN_LENGTH = 32;

type Auth = { ok: true; guestUserId: number } | { ok: false; status: 401 | 503; error: string };

/** Unconfigured is 503, not 401: Game Frame's outbox retries both, but only 401 means its token is wrong. */
function authorize(req: NextApiRequest): Auth {
  const expected = env.GF_REPORT_TOKEN ?? '';
  const guestUserId = env.GAMES_GUEST_USER_ID;
  if (expected.length < MIN_TOKEN_LENGTH || typeof guestUserId !== 'number')
    return { ok: false, status: 503, error: 'not_configured' };

  const a = Buffer.from(blockBearerToken(req));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, status: 401, error: 'unauthorized' };
  return { ok: true, guestUserId };
}

function invalid(res: NextApiResponse, issues: { path: PropertyKey[]; message: string }[]) {
  return res.status(400).json({
    error: 'invalid',
    message: issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  });
}

async function fail(res: NextApiResponse, route: string, error: unknown) {
  await logToAxiom({
    name: 'game-frame-reports',
    type: 'error',
    route,
    message: error instanceof Error ? error.message : String(error),
  }).catch(() => null);
  return res.status(500).json({ error: 'internal' });
}

export async function gameFrameReportHandler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const auth = authorize(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const parsed = gameFrameReportSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  const idempotencyKey = req.headers['idempotency-key'];
  if (idempotencyKey !== undefined && idempotencyKey !== parsed.data.gfReportId)
    return res
      .status(400)
      .json({ error: 'invalid', message: 'Idempotency-Key must equal gfReportId' });

  try {
    const result = await fileGameFrameReport(parsed.data, { guestUserId: auth.guestUserId });
    if (!result.ok) return res.status(422).json({ error: result.error });
    return res.status(200).json({ reportId: result.reportId, result: result.result });
  } catch (error) {
    return fail(res, 'reports', error);
  }
}

export async function gameFrameStateHandler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') return res.status(405).json({ error: 'method_not_allowed' });
  const auth = authorize(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const slug = gameFrameSlugSchema.safeParse(req.query.slug);
  if (!slug.success) return invalid(res, slug.error.issues);
  const parsed = gameFrameStateSchema.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues);
  if (parsed.data.slug !== slug.data)
    return res.status(400).json({ error: 'invalid', message: 'body slug must equal the path' });

  try {
    const applied = await applyGameFrameState(parsed.data);
    if (!applied) return res.status(404).json({ error: 'unknown_game' });
    return res.status(200).json(applied);
  } catch (error) {
    return fail(res, 'games', error);
  }
}
