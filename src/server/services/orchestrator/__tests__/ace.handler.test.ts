import { describe, expect, it } from 'vitest';

import { createAceAudioInput } from '../form-graph/ace.handler';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

const ctx = {
  airs: { getOrThrow: (id: number) => `air:${id}` },
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
  canUseMusic: true,
} as unknown as GenerationHandlerCtx;

const custom = (extra: Record<string, unknown>) => ({
  ecosystem: 'Ace',
  aceAudioMode: 'custom',
  musicDescription: 'synthwave, dreamy',
  lyrics: '[Verse]\nneon rain',
  duration: 30,
  seed: 7,
  ...extra,
});

async function steps(data: Record<string, unknown>, canUseMusic = true) {
  return (await createAceAudioInput(data as never, { ...ctx, canUseMusic })) as unknown as {
    $type: string;
    input: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }[];
}
const songStep = async (data: Record<string, unknown>, canUseMusic = true) =>
  (await steps(data, canUseMusic)).find((s) => s.$type === 'aceStepAudio')!;

// With a `cover`, ACE muxes the song into an MP4 over the image, which the song scan can't read.
describe('an ACE song with a cover, for a music flag holder', () => {
  it('generates the cover in its own step and asks ACE for the song alone', async () => {
    const all = await steps(custom({ generateCover: true }));
    expect(all.map((s) => s.$type)).toEqual(['imageGen', 'aceStepAudio']);
    const song = all[1];
    expect(song.input).not.toHaveProperty('cover');
    expect(song.input).toMatchObject({ prompt: 'synthwave, dreamy', duration: 30 });
  });

  it('keeps an uploaded cover on the song step for posting, not as ACE input', async () => {
    const song = await songStep(
      custom({ images: [{ url: 'https://orch/blob/cover.png', width: 1024, height: 1024 }] })
    );
    expect(song.input).not.toHaveProperty('cover');
    expect(song.metadata).toEqual({
      coverImage: { url: 'https://orch/blob/cover.png', width: 1024, height: 1024 },
    });
  });

  it('adds nothing for a song without a cover', async () => {
    const song = await songStep(custom({}));
    expect(song.input).not.toHaveProperty('cover');
    expect(song.metadata).toBeUndefined();
  });
});

// Without the flag a song can't be posted as audio, so ACE muxes it over the cover into a postable MP4.
describe('an ACE song with a cover, without the music flag', () => {
  it('passes the generated cover to ACE', async () => {
    const all = await steps(custom({ generateCover: true }), false);
    expect(all.map((s) => s.$type)).toEqual(['imageGen', 'aceStepAudio']);
    expect(all[1].input.cover).toEqual({ imageUrl: { $ref: '$0', path: 'output.images[0].url' } });
    expect(all[1].metadata).toBeUndefined();
  });

  it('passes an uploaded cover to ACE instead of keeping it for posting', async () => {
    const song = await songStep(
      custom({ images: [{ url: 'https://orch/blob/cover.png', width: 1024, height: 1024 }] }),
      false
    );
    expect(song.input.cover).toEqual({ imageUrl: 'https://orch/blob/cover.png' });
    expect(song.metadata).toBeUndefined();
  });

  it('adds nothing for a song without a cover', async () => {
    const song = await songStep(custom({}), false);
    expect(song.input).not.toHaveProperty('cover');
    expect(song.metadata).toBeUndefined();
  });
});
