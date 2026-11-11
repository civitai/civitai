import { describe, expect, it, vi } from 'vitest';
import {
  auditTrainingSamplePrompts,
  collectPassThroughAuditText,
  PASS_THROUGH_AUDIT_TEXT_MAX,
  PROMPT_AUDITED_STEP_TYPES,
  PROMPT_TOO_LARGE_MESSAGE,
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

  it.each([
    ['a free-text field with any name', { description: { $ref: '$arguments', path: 'd' } }],
    ['a nested field', { settings: { voice: { $ref: 'chat', path: 'output.text' } } }],
    ['a text field under a media field', { image: { caption: { $ref: '$arguments', path: 'c' } } }],
  ])('treats a reference in %s as an unreadable prompt', (_, input) => {
    const got = collectPassThroughAuditText([{ $type: 'videoGen', input }]);
    expect(got.promptRefs).toHaveLength(1);
  });

  it('audits exactly these step types', () => {
    expect([...PROMPT_AUDITED_STEP_TYPES].sort()).toEqual(
      [
        'aceStepAudio',
        'comfy',
        'customComfy',
        'imageGen',
        'imageToSvg',
        'liveTextToSpeech',
        'miniMaxMusic3',
        'polyGen',
        'soniloAudioGen',
        'textToImage',
        'textToSpeech',
        'videoGen',
        'yuE2',
      ].sort()
    );
  });

  it('flags input nested past the walk bound', () => {
    let deep: unknown = 'words';
    for (let i = 0; i < 70; i++) deep = { a: deep };
    expect(collectPassThroughAuditText([{ $type: 'videoGen', input: deep }]).tooLarge).toBe(true);
  });

  it('control: text of exactly the moderation limit is not flagged', () => {
    const got = collectPassThroughAuditText([
      { $type: 'videoGen', input: { prompt: 'a'.repeat(PASS_THROUGH_AUDIT_TEXT_MAX) } },
    ]);
    expect(got.tooLarge).toBe(false);
  });

  it('flags text over the moderation limit', () => {
    const got = collectPassThroughAuditText([
      { $type: 'videoGen', input: { prompt: 'a'.repeat(PASS_THROUGH_AUDIT_TEXT_MAX + 1) } },
    ]);
    expect(got.tooLarge).toBe(true);
  });

  it('reads an object that carries a $ref key but is not a reference', () => {
    const got = collectPassThroughAuditText([
      {
        $type: 'customComfy',
        input: {
          workflow: {
            '6': {
              $ref: 'x',
              path: 'y',
              class_type: 'CLIPTextEncode',
              inputs: { t: 'hidden words' },
            },
          },
        },
      },
    ]);
    expect(got.prompt).toContain('hidden words');
  });

  it('reads the default of a reference', () => {
    const got = collectPassThroughAuditText([
      {
        $type: 'videoGen',
        input: { images: [{ $ref: 'gen', path: 'url', default: 'fallback words' }] },
      },
    ]);
    expect(got.prompt).toContain('fallback words');
  });

  it('in a graph step, treats every reference as an unreadable prompt', () => {
    const got = collectPassThroughAuditText([
      {
        $type: 'customComfy',
        input: { workflow: { '6': { inputs: { t: { $ref: '$arguments', path: 'p' } } } } },
      },
    ]);
    expect(got.promptRefs).toEqual(['argument']);
  });

  it('in a graph step, reads negative-named and url-shaped leaves as prompt text', () => {
    const got = collectPassThroughAuditText([
      {
        $type: 'customComfy',
        input: { workflow: { negative_node: { inputs: { v: 'https://example.com/some words' } } } },
      },
    ]);
    expect(got).toMatchObject({ negativePrompt: '' });
    expect(got.prompt).toContain('https://example.com/some words');
  });
});

describe('auditTrainingSamplePrompts', () => {
  const ctx = (samplePrompts: string[]) => ({
    samplePrompts,
    userId: 1,
    appBlockId: 'apb_test',
    isGreen: true,
    loadIsModerator: vi.fn(async () => false),
  });

  it('enforce: refuses sample prompts over the moderation limit before any audit call', async () => {
    const long = ctx(['a'.repeat(PASS_THROUGH_AUDIT_TEXT_MAX + 1)]);
    await expect(auditTrainingSamplePrompts(long, 'enforce')).rejects.toThrow(
      PROMPT_TOO_LARGE_MESSAGE
    );
    expect(long.loadIsModerator).not.toHaveBeenCalled();
  });
});

describe('collectPassThroughAuditText on a training step', () => {
  it('reads the sample prompts and nothing else the trainer is not generating from', () => {
    const got = collectPassThroughAuditText([
      {
        $type: 'training',
        input: {
          engine: 'ai-toolkit',
          ecosystem: 'sdxl',
          triggerWord: 'mychar',
          trainingData: { type: 'blobs', items: [{ air: 'K1.jpeg', caption: 'a caption' }] },
          samples: { prompts: ['mychar on a beach', 'mychar badword'], cfgScale: 4 },
          params: { optimizerType: 'adamw8bit' },
        },
      },
    ]);
    expect(got.auditedTypes).toEqual(['training']);
    expect(got.prompt.split('\n')).toEqual(['mychar on a beach', 'mychar badword']);
    expect(got.negativePrompt).toBe('');
  });

  it('reads samplePrompts and negativePrompt, however the type and keys are cased', () => {
    const got = collectPassThroughAuditText([
      {
        $type: 'ImageResourceTraining',
        input: { SamplePrompts: ['a lake'], NegativePrompt: 'blurry', loraName: 'x' },
      },
    ]);
    expect(got.auditedTypes).toEqual(['imageresourcetraining']);
    expect(got.prompt).toBe('a lake');
    expect(got.negativePrompt).toBe('blurry');
  });

  it('records a reference in the sample prompts as an unreadable prompt', () => {
    const got = collectPassThroughAuditText([
      { $type: 'training', input: { samples: { prompts: { $ref: '$arguments', path: 'p' } } } },
    ]);
    expect(got.promptRefs).toEqual(['argument']);
  });
});
