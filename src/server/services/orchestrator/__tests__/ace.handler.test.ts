import { describe, expect, it } from 'vitest';

import { createAceAudioInput } from '../form-graph/ace.handler';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

const ctx = {
  airs: { getOrThrow: (id: number) => `air:${id}` },
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
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

async function steps(data: Record<string, unknown>) {
  return (await createAceAudioInput(data as never, ctx)) as unknown as {
    $type: string;
    input: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }[];
}
const songStep = async (data: Record<string, unknown>) =>
  (await steps(data)).find((s) => s.$type === 'aceStepAudio')!;

// With a `cover`, ACE muxes the song into an MP4 over the image, which the song scan can't read.
describe('an ACE song with a cover', () => {
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
