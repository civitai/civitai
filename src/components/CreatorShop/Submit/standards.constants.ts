import { CosmeticType } from '~/shared/utils/prisma/enums';

// Public, mod- and creator-facing quality standards, mirrored from the shared
// standards doc: https://hackmd.io/@civitai/rJFF6LaEfx
type CosmeticStandard = {
  requirements: { key: string; label: string }[];
  // Starter template served from /public (exact spec shape with correct alpha).
  template: { url: string; downloadName: string };
};

// Only the three creator-listable cosmetic types have standards.
export const COSMETIC_STANDARDS: Partial<Record<CosmeticType, CosmeticStandard>> = {
  [CosmeticType.Badge]: {
    requirements: [
      {
        key: 'hexagon',
        label:
          'Built on a hexagon frame. Elements can break out of it, but the hexagon stays the recognizable base.',
      },
      {
        key: 'consistent',
        label: 'Keep the hexagon a consistent size so badges sit together cleanly.',
      },
      {
        key: 'is-badge',
        label: 'If a design cannot work as a hexagon, it probably is not a badge.',
      },
    ],
    template: {
      url: '/images/cosmetic-templates/badge.png',
      downloadName: 'civitai-badge-template.png',
    },
  },
  [CosmeticType.ProfileDecoration]: {
    requirements: [
      {
        key: 'visible',
        label:
          'At least 50% of the avatar stays visible. Frame the image, do not cover the center.',
      },
      {
        key: 'effects',
        label:
          'Intentional effects like a censor bar are fine as long as at least 50% still shows.',
      },
    ],
    template: {
      url: '/images/cosmetic-templates/avatar-frame.png',
      downloadName: 'civitai-avatar-frame-template.png',
    },
  },
  [CosmeticType.ProfileBackground]: {
    requirements: [
      {
        key: 'light-text',
        label:
          'Keep it light on text. A single piece of large text is fine and stays readable behind the profile stats.',
      },
      { key: 'no-wall', label: 'Avoid backgrounds filled with small text meant to be read.' },
      {
        key: 'behind',
        label:
          'Effects and imagery should sit behind the creator card without competing with the content.',
      },
    ],
    template: {
      url: '/images/cosmetic-templates/profile-background.png',
      downloadName: 'civitai-profile-background-template.png',
    },
  },
};
