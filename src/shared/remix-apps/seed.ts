import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';
import type { RemixAppInput } from '~/shared/remix-apps/row.schema';

const NO_TEXT = "Don't add any text or lettering.";

/** A one-image edit of the source: what every one-shot app was before it became a row. */
const edit = (
  slug: string,
  name: string,
  icon: RemixAppInput['spec']['icon'],
  prompt: string
): RemixAppInput => ({
  slug,
  name,
  target: 'image.remix',
  spec: {
    icon,
    engine: DEFAULT_ENGINE,
    asks: [],
    steps: [{ kind: 'image', prompt, aspectRatio: 'source', quantity: 1, input: 'source' }],
  },
});

const restyleOption = (value: string, label: string, look: string, noText = NO_TEXT) => ({
  value,
  label,
  fragments: { look, noText },
});

/**
 * The system apps as rows, in menu order. The seed migration inserts exactly these
 * (`20261225120200_remix_apps_as_rows`), and `getRemixAppRegistry` serves them until it has.
 */
export const SEED_REMIX_APPS: RemixAppInput[] = [
  edit(
    'anime-it',
    'Anime it',
    'sparkles',
    `Redraw this image as a 2D anime illustration with clean black line art, flat cel shading with hard-edged shadow shapes, and simple flat colors. If the source is a photo or a 3D render, convert every surface into hand-drawn anime style, with no photographic texture and no realistic rendering. Keep the subject, pose and composition. ${NO_TEXT}`
  ),
  {
    slug: 'pick-of-four',
    name: 'Pick of four',
    description: 'Four takes on this image. Keep your favourite, or upscale it.',
    target: 'image.remix',
    spec: { icon: 'pick', code: 'pick-of-four' },
  },
  {
    slug: 'restyle',
    name: 'Restyle',
    description: 'Pick a style, and add something to the scene if you like.',
    target: 'image.remix',
    spec: {
      icon: 'palette',
      engine: DEFAULT_ENGINE,
      asks: [
        {
          id: 'extra',
          kind: 'text',
          prompt: 'Add something to the scene (optional)',
          maxLength: 120,
          optional: true,
          wrap: { before: ' Also add to the scene: ', after: '.' },
        },
        {
          id: 'style',
          kind: 'choice',
          prompt: 'Pick a style',
          options: [
            restyleOption(
              'watercolor',
              'Watercolor',
              'a loose watercolor painting on textured paper, with soft washes and visible brush edges'
            ),
            restyleOption(
              'oil-painting',
              'Oil painting',
              'a classical oil painting on canvas, with rich colour and visible brushstrokes'
            ),
            // Ukiyo-e outputs drew a seal stamp with characters under the plain no-text line.
            restyleOption(
              'ukiyo-e',
              'Ukiyo-e',
              'a Japanese ukiyo-e woodblock print, with flat colour, bold outlines and paper grain',
              "Don't add any text, lettering, seals or stamps."
            ),
            restyleOption(
              'cyberpunk-neon',
              'Cyberpunk neon',
              'a cyberpunk night scene lit by neon signs, with magenta and cyan glow and wet reflections'
            ),
            restyleOption(
              'claymation',
              'Claymation',
              'a stop-motion claymation scene, with plasticine figures and fingerprint texture'
            ),
          ],
        },
      ],
      steps: [
        {
          kind: 'image',
          prompt:
            'Restyle this image as {{look}}. Keep the subject, their pose and the composition the same.{{extra}} {{noText}}',
          aspectRatio: 'source',
          quantity: 1,
          input: 'source',
        },
      ],
    },
  },
  edit(
    'make-it-real',
    'Make it real',
    'camera',
    `Turn this image into a live-action photograph of the real person (or the real animal or object) shown, in the same outfit, pose and setting, as if shot on a DSLR in natural light: real skin, hair, fabric and materials, and real surroundings. Nothing may look drawn, painted or rendered, with no line art, no cel shading and no glossy anime eyes. Keep the pose, outfit and composition. ${NO_TEXT}`
  ),
  edit(
    'toy-figure',
    'Toy figure',
    'toy',
    `Turn the subject into a collectible toy figure in its packaging box, product photo. ${NO_TEXT}`
  ),
  edit(
    'pixel-art',
    'Pixel art',
    'grid',
    `Redraw this image as true low-resolution pixel art, as if drawn on a 160 by 240 pixel grid and scaled up with nearest-neighbor: large, clearly visible square pixels, hard stair-stepped edges, no anti-aliasing or smooth gradients, and a limited palette of about 16 flat colors with simple dithering. Keep the subject, pose and composition. ${NO_TEXT}`
  ),
  edit(
    'pencil-sketch',
    'Pencil sketch',
    'pencil',
    `Redraw this image as a detailed graphite pencil sketch on paper. ${NO_TEXT}`
  ),
  edit(
    'claymation',
    'Claymation',
    'clay',
    `Recreate this image as a stop-motion claymation scene with plasticine figures. ${NO_TEXT}`
  ),
];
