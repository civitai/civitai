import { describe, expect, it } from 'vitest';
import {
  collectPassThroughAuditText,
  PASS_THROUGH_AUDIT_TEXT_MAX,
  PROMPT_AUDITED_STEP_TYPES,
} from '~/server/services/blocks/pass-through-prompt-audit';

describe('collectPassThroughAuditText', () => {
  it.each(PROMPT_AUDITED_STEP_TYPES)('reads the prompt of a %s step', ($type) => {
    const got = collectPassThroughAuditText([{ $type, input: { prompt: 'a red fox' } }]);
    expect(got.auditedTypes).toEqual([$type.toLowerCase()]);
    expect(got.prompt).toBe('a red fox');
  });

  it('matches the $type however it is cased', () => {
    const got = collectPassThroughAuditText([{ $type: 'VIDEOGEN', input: { prompt: 'x' } }]);
    expect(got.auditedTypes).toEqual(['videogen']);
  });

  it('control: a step type outside the list is not read', () => {
    const got = collectPassThroughAuditText([{ $type: 'convertImage', input: { prompt: 'x' } }]);
    expect(got).toMatchObject({ auditedTypes: [], prompt: '' });
  });

  it('reads nested and differently cased prompt fields, and keeps negatives apart', () => {
    const got = collectPassThroughAuditText([
      {
        $type: 'videoGen',
        input: {
          engine: 'kling-v4',
          Prompt: 'opening shot',
          multiPrompt: [{ prompt: 'second shot' }, { prompt: 'third shot' }],
          negativePrompt: 'blurry',
          images: ['https://image.civitai.com/abc/def.jpeg'],
          model: 'urn:air:wan:checkpoint:civitai:1@2',
        },
      },
    ]);
    expect(got.prompt.split('\n')).toEqual([
      'kling-v4',
      'opening shot',
      'second shot',
      'third shot',
    ]);
    expect(got.negativePrompt).toBe('blurry');
  });

  it('audits a URL that sits in a prompt field', () => {
    const got = collectPassThroughAuditText([
      { $type: 'imageGen', input: { prompt: 'https://example.com/some words' } },
    ]);
    expect(got.prompt).toBe('https://example.com/some words');
  });

  it('follows a repeat into its template', () => {
    const got = collectPassThroughAuditText([
      {
        $type: 'repeat',
        input: {
          for: { $ref: '$arguments', path: 'frames', as: 'frame' },
          template: { $type: 'videoGen', input: { prompt: 'loop prompt' } },
        },
      },
    ]);
    expect(got).toMatchObject({
      auditedTypes: ['videogen'],
      prompt: 'loop prompt',
      promptRefs: [],
    });
  });

  it('records a reference in a prompt field by its source', () => {
    const got = collectPassThroughAuditText([
      { $type: 'videoGen', input: { prompt: { $ref: '$arguments', path: 'p' } } },
      { $type: 'imageGen', input: { prompt: { $ref: 'chat', path: 'output.text' } } },
    ]);
    expect(got.promptRefs).toEqual(['argument', 'step']);
  });

  it('treats an input that is itself a reference as an unreadable prompt', () => {
    const got = collectPassThroughAuditText([
      { $type: 'videoGen', input: { $ref: '$arguments', path: 'input' } },
    ]);
    expect(got.promptRefs).toEqual(['argument']);
  });

  it('control: a reference in a media field is not a prompt reference', () => {
    const got = collectPassThroughAuditText([
      {
        $type: 'videoGen',
        input: { prompt: 'animate it', images: [{ $ref: 'gen', path: 'output.images[0].url' }] },
      },
    ]);
    expect(got).toMatchObject({ prompt: 'animate it', promptRefs: [] });
  });

  it('flags text over the moderation limit', () => {
    const got = collectPassThroughAuditText([
      { $type: 'videoGen', input: { prompt: 'a'.repeat(PASS_THROUGH_AUDIT_TEXT_MAX + 1) } },
    ]);
    expect(got.tooLarge).toBe(true);
  });
});
