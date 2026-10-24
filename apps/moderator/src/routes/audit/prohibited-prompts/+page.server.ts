import type { PageServerLoad } from './$types';
import {
  getTodaysProhibitedPrompts,
  getTodaysProhibitedUserCounts,
} from '$lib/server/prohibited-prompts.service';
import { getPromptHighlightSegments } from '@civitai/mod-utils/prompt-audit';

// Read today's prohibited prompts + per-user counts from ClickHouse, and run each prompt through the audit
// (server-side — the word lists are server-only) so the page can highlight what tripped it.
export const load: PageServerLoad = async () => {
  const [rows, userCounts] = await Promise.all([
    getTodaysProhibitedPrompts(),
    getTodaysProhibitedUserCounts(),
  ]);

  const prompts = rows.map((r) => {
    const seg = getPromptHighlightSegments(r.prompt, r.negativePrompt || null);
    return {
      userId: r.userId,
      source: r.source,
      createdDate: r.createdDate,
      promptSegments: seg.prompt,
      negativeSegments: seg.negativePrompt,
    };
  });

  return { prompts, userCounts };
};
