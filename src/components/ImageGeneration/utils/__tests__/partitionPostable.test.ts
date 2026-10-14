import { describe, expect, it } from 'vitest';

import { partitionPostable } from '~/components/ImageGeneration/utils/partitionPostable';

const allowed = () => ({ allowed: true as const });
const refused = (message: string) => () => ({ allowed: false as const, message });

const image = { mediaType: 'image', canUse: allowed };
const avatar = { mediaType: 'image', canUse: refused("Avatar results can't be posted") };
const audio = { mediaType: 'audio', canUse: allowed };

describe('partitionPostable', () => {
  it('posts everything, silently, when all can be posted', () => {
    expect(partitionPostable([image, image])).toEqual({ postable: [image, image] });
  });

  it('refuses with the reason when none can be posted', () => {
    expect(partitionPostable([avatar, avatar])).toEqual({
      postable: [],
      notice: {
        kind: 'error',
        title: 'None of the selected outputs can be posted',
        message: "Avatar results can't be posted.",
      },
    });
  });

  it('refuses an audio-only selection', () => {
    expect(partitionPostable([audio]).notice).toMatchObject({
      kind: 'error',
      message: "Audio outputs can't be added to a post.",
    });
  });

  it('names audio, not the workflow, for restricted audio', () => {
    const restrictedAudio = { ...audio, canUse: avatar.canUse };
    expect(partitionPostable([restrictedAudio]).notice?.message).toBe(
      "Audio outputs can't be added to a post."
    );
  });

  it('asks about posting', () => {
    const uses: string[] = [];
    partitionPostable([
      { mediaType: 'image', canUse: (use: string) => (uses.push(use), allowed()) },
    ]);
    expect(uses).toEqual(['post']);
  });

  it('posts the rest and names every reason in one notice', () => {
    const { postable, notice } = partitionPostable([image, avatar, audio]);
    expect(postable).toEqual([image]);
    expect(notice).toEqual({
      kind: 'warning',
      title: 'Some outputs were left out',
      message:
        "2 of 3 selected outputs can't be posted. Avatar results can't be posted. Audio outputs can't be added to a post.",
    });
  });
});
