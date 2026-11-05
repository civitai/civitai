import type { GenerationAspectRatio } from '~/shared/constants/generation.constants';
import { REMIX_ENGINES, type RemixTier } from '~/shared/constants/remix.constants';

export type RemixAppEngine = { ecosystem: string; versionId: number };

/** One remix app: data run by `remix-app.service`, never app code. */
export type RemixAppDefinition = {
  slug: string;
  name: string;
  icon: string;
  description?: string;
  output: 'image';
  /** `mature` absent = the app refuses mature sources. */
  engine: { safe: RemixAppEngine; mature?: RemixAppEngine };
  prompt: string;
  caption?: { instructions: string };
  params: { aspectRatio: 'source' | GenerationAspectRatio; quantity: 1 | 2 | 4 };
  after: 'queue' | 'post' | 'remixGallery';
};

const editEngine = (tier: RemixTier): RemixAppEngine => ({
  ecosystem: REMIX_ENGINES.edit[tier].ecosystemKey,
  versionId: REMIX_ENGINES.edit[tier].modelVersionId,
});

export const DEFAULT_ENGINE: RemixAppDefinition['engine'] = {
  safe: editEngine('safe'),
  mature: editEngine('mature'),
};

/** One-shot apps not yet on the remix app runtime (`~/shared/remix-apps/system-apps`). */
export const SYSTEM_REMIX_APPS: RemixAppDefinition[] = [
  {
    slug: 'make-it-real',
    name: 'Make it real',
    icon: 'camera',
    output: 'image',
    engine: DEFAULT_ENGINE,
    prompt: 'Turn this image into a realistic photograph, keeping the subject and composition.',
    params: { aspectRatio: 'source', quantity: 1 },
    after: 'queue',
  },
  {
    slug: 'toy-figure',
    name: 'Toy figure',
    icon: 'toy',
    output: 'image',
    engine: DEFAULT_ENGINE,
    prompt: 'Turn the subject into a collectible toy figure in its packaging box, product photo.',
    params: { aspectRatio: 'source', quantity: 1 },
    after: 'queue',
  },
  {
    slug: 'pixel-art',
    name: 'Pixel art',
    icon: 'grid',
    output: 'image',
    engine: DEFAULT_ENGINE,
    prompt: 'Redraw this image as detailed 16-bit pixel art, keeping the composition.',
    params: { aspectRatio: 'source', quantity: 1 },
    after: 'queue',
  },
  {
    slug: 'pencil-sketch',
    name: 'Pencil sketch',
    icon: 'pencil',
    output: 'image',
    engine: DEFAULT_ENGINE,
    prompt: 'Redraw this image as a detailed graphite pencil sketch on paper.',
    params: { aspectRatio: 'source', quantity: 1 },
    after: 'queue',
  },
  {
    slug: 'claymation',
    name: 'Claymation',
    icon: 'clay',
    output: 'image',
    engine: DEFAULT_ENGINE,
    prompt: 'Recreate this image as a stop-motion claymation scene with plasticine figures.',
    params: { aspectRatio: 'source', quantity: 1 },
    after: 'queue',
  },
];

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
  after: 'remixGallery',
};

export function teamRemixApp(team: string): RemixAppDefinition {
  return { ...TEAM_REMIX_APP, prompt: TEAM_REMIX_PROMPT.replaceAll('{{team}}', team) };
}

export function getSystemRemixApp(slug: string) {
  return SYSTEM_REMIX_APPS.find((app) => app.slug === slug);
}
