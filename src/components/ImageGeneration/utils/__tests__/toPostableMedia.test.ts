import { describe, expect, it } from 'vitest';
import { toPostableMedia } from '~/components/ImageGeneration/utils/toPostableMedia';

const output = (over: Record<string, unknown>) =>
  ({
    url: 'https://orchestrator/blob',
    workflowId: 'wf-1',
    mediaType: 'image',
    params: {},
    workflow: { metadata: { params: {} } },
    step: { params: {}, resources: [] },
    ...over,
  } as never);

describe('toPostableMedia', () => {
  it('posts an image with its step meta and workflow id, nothing audio', () => {
    const media = toPostableMedia(output({ step: { params: { prompt: 'a cat', seed: 7 } } }));
    expect(media).toEqual({
      url: 'https://orchestrator/blob',
      meta: { prompt: 'a cat', seed: 7 },
      generationWorkflowId: 'wf-1',
    });
  });

  it('flags a song and carries the title, lyrics and bpm of a custom-mode form', () => {
    const params = { title: 'Night Drive', lyrics: 'la\nla', bpm: 128, musicDescription: 'synth' };
    const media = toPostableMedia(
      output({ mediaType: 'audio', params, step: { params }, workflow: { metadata: { params } } })
    );
    expect(media.mediaType).toBe('audio');
    expect(media.audioMetadata).toEqual({
      title: 'Night Drive',
      lyrics: [
        { t: null, text: 'la' },
        { t: null, text: 'la' },
      ],
      bpm: 128,
    });
    expect(media.meta).toMatchObject({ musicDescription: 'synth' });
  });

  it('takes the title from the workflow when the step carries no params of its own', () => {
    const media = toPostableMedia(
      output({
        mediaType: 'audio',
        params: {},
        workflow: { metadata: { params: { title: 'From Workflow' } } },
      })
    );
    expect(media.audioMetadata).toEqual({ title: 'From Workflow' });
  });

  it("lets the output's own params win over the workflow's, and keeps the seed in meta", () => {
    const media = toPostableMedia(
      output({
        mediaType: 'audio',
        params: { title: 'Step Title' },
        workflow: { metadata: { params: { title: 'Workflow Title' } } },
        step: { params: { title: 'Step Title', seed: 42, musicDescription: 'synth' } },
      })
    );
    expect(media.audioMetadata?.title).toBe('Step Title');
    expect(media.meta).toMatchObject({ seed: 42, musicDescription: 'synth' });
  });
});
