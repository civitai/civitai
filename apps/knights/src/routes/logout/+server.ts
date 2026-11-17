import { env } from '$env/dynamic/private';
import { spokeLogout } from '@civitai/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request }) =>
  spokeLogout(request, { hubBase: env.AUTH_JWT_ISSUER ?? null });
