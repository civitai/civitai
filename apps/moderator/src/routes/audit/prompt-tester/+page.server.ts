import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';
import {
  getPromptHighlightSegments,
  type PromptSegment,
} from '@civitai/mod-utils/prompt-audit';

// The prompt audit runs SERVER-SIDE (the detection word lists are ~50KB and server-only), so unlike the
// legacy client-only page this is a form action: take a prompt (or a JSON array of { prompt,
// negativePrompt }), run the audit, and hand back the highlighted segments + verdict for the client.
export type AuditResult = {
  prompt: string;
  negativePrompt?: string;
  includesInappropriate: boolean;
  promptSegments: PromptSegment[];
  negativeSegments: PromptSegment[] | null;
};

export const actions: Actions = {
  audit: async ({ request }) => {
    const form = await request.formData();
    const raw = String(form.get('input') ?? '').trim();
    if (!raw) return fail(400, { error: 'Enter a prompt, or a JSON array of { prompt, negativePrompt }.' });

    let inputs: { prompt?: unknown; negativePrompt?: unknown }[];
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('not an array');
        inputs = parsed;
      } catch {
        return fail(400, { error: 'Invalid JSON — expected an array of { prompt, negativePrompt }.' });
      }
    } else {
      inputs = [{ prompt: raw }];
    }

    const results: AuditResult[] = inputs
      .filter((i): i is { prompt: string; negativePrompt?: string } => typeof i?.prompt === 'string')
      .map(({ prompt, negativePrompt }) => {
        const seg = getPromptHighlightSegments(prompt, negativePrompt ?? null);
        return {
          prompt,
          negativePrompt,
          includesInappropriate: seg.includesInappropriate,
          promptSegments: seg.prompt,
          negativeSegments: seg.negativePrompt,
        };
      });

    return { input: raw, results };
  },
};
