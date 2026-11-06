import type { GenerationAspectRatio } from '~/shared/constants/generation.constants';
import { REMIX_ENGINES, type RemixTier } from '~/shared/constants/remix.constants';

export type RemixAppEngine = { ecosystem: string; versionId: number };

/** A one-shot remix app, run by `remixApp.run`: today only the team remix. */
export type RemixAppDefinition = {
  slug: string;
  name: string;
  icon: string;
  description?: string;
  output: 'image';
  /** `mature` absent = the app refuses mature sources. */
  engine: { safe: RemixAppEngine; mature?: RemixAppEngine };
  prompt: string;
  params: { aspectRatio: 'source' | GenerationAspectRatio; quantity: 1 | 2 | 4 };
};

const editEngine = (tier: RemixTier): RemixAppEngine => ({
  ecosystem: REMIX_ENGINES.edit[tier].ecosystemKey,
  versionId: REMIX_ENGINES.edit[tier].modelVersionId,
});

export const DEFAULT_ENGINE: RemixAppDefinition['engine'] = {
  safe: editEngine('safe'),
  mature: editEngine('mature'),
};

export const TEAM_REMIX_SLUG = 'team-remix';

/**
 * `{{team}}` is the viewer's own team, filled in on the server from their event join.
 * 🔴 No number beside "birthday" or "years": the prompt audit reads "4th birthday" as a minor's
 * age and refuses it.
 */
export const TEAM_REMIX_PROMPT =
  "Turn this image into a Civitai anniversary party for Team {{team}}. Keep the main subject, their pose, the composition and the art style exactly the same. Add a festive {{team}}-colored party hat on the main subject, plus a light scatter of {{team}}-toned confetti and streamers. Keep the additions tasteful, and don't cover faces or the focal point. Don't add any text or lettering.";

/** Offered only on a hatted image's remix gallery, to a viewer who joined a team; not in the menu. */
export const TEAM_REMIX_APP: RemixAppDefinition = {
  slug: TEAM_REMIX_SLUG,
  name: 'Remix for your team',
  icon: 'sparkles',
  output: 'image',
  engine: { safe: editEngine('safe') },
  prompt: TEAM_REMIX_PROMPT,
  params: { aspectRatio: 'source', quantity: 1 },
};

export function teamRemixApp(team: string): RemixAppDefinition {
  return { ...TEAM_REMIX_APP, prompt: TEAM_REMIX_PROMPT.replaceAll('{{team}}', team) };
}
