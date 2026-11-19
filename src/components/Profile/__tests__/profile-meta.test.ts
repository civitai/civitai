import { describe, expect, it } from 'vitest';
import { buildProfileMeta } from '~/components/Profile/profile-meta';

describe('profile meta', () => {
  it('leads with the two biggest kinds of content the creator has', () => {
    expect(
      buildProfileMeta({
        username: 'maker',
        overview: { modelCount: 12, imageCount: 3400, videoCount: 2, articleCount: 0 },
        followers: 2100,
      })
    ).toEqual({
      title: 'maker: 3.4k images and 12 AI models | Civitai',
      description:
        'maker on Civitai: 3.4k images and 12 AI models, followed by 2.1k people. Download or generate online.',
    });
  });

  it('does not advertise content the creator has none of', () => {
    const { title, description } = buildProfileMeta({
      username: 'maker',
      overview: { modelCount: 0, imageCount: 5 },
      followers: 0,
    });
    expect(title).toBe('maker: 5 images | Civitai');
    expect(description).not.toContain('models');
    expect(description).not.toContain('followed');
  });

  it('falls back to a generic snippet with no overview', () => {
    expect(buildProfileMeta({ username: 'maker', overview: null })).toEqual({
      title: 'maker | AI Creator on Civitai',
      description:
        "Browse maker's AI models, images and articles on Civitai. Download or generate online.",
    });
  });
});
