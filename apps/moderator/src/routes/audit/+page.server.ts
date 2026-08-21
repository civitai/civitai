import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// /audit is the Audit group path (gating + icon + nav parent), not a page — its tools live at
// /audit/prohibited-prompts, /audit/prompt-tester, and /audit/scanner-audit. Send the bare path to the
// prohibited-prompts monitor.
export const load: PageServerLoad = () => {
  redirect(307, '/audit/prohibited-prompts');
};
