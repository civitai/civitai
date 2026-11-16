import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Ranks moved into the Codex; old links and bookmarks land on its ranks section. */
export const GET: RequestHandler = () => redirect(308, '/codex#ranks');
