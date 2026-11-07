import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** The rules moved into the Codex; old links and bookmarks land on its "How judging works" section. */
export const GET: RequestHandler = () => redirect(308, '/codex#judging');
