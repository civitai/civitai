import { spokeAuthorize } from '@civitai/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request }) => spokeAuthorize(request);
