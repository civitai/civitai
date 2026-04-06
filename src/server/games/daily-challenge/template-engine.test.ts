import { describe, it, expect, vi } from 'vitest';
import { parseReviewTemplate, resolveTemplate } from './template-engine';
import type { ReviewTemplate } from './template-engine';

describe('parseReviewTemplate', () => {
  it('parses a valid template', () => {
    const json = JSON.stringify({
      messages: [
        { role: 'system', content: 'You are a judge.' },
        { role: 'user', content: [{ type: 'text', text: 'Review this' }] },
      ],
    });

    const result = parseReviewTemplate(json);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toBe('You are a judge.');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseReviewTemplate('not json')).toThrow();
  });

  it('throws on schema mismatch — missing messages', () => {
    expect(() => parseReviewTemplate(JSON.stringify({ prompts: [] }))).toThrow();
  });

  it('throws on schema mismatch — wrong role', () => {
    const json = JSON.stringify({
      messages: [{ role: 'moderator', content: 'hello' }],
    });
    expect(() => parseReviewTemplate(json)).toThrow();
  });

  it('throws on empty messages array', () => {
    const json = JSON.stringify({ messages: [] });
    expect(() => parseReviewTemplate(json)).toThrow();
  });
});

describe('resolveTemplate', () => {
  const variables = {
    systemPrompt: 'You are a challenge judge.',
    reviewPrompt: 'Rate this image.',
    theme: 'sunset landscape',
    themeElements: 'warm orange hues, horizon line, golden hour lighting',
  };

  it('replaces variables in string content', () => {
    const template: ReviewTemplate = {
      messages: [
        { role: 'system', content: '{{systemPrompt}}' },
        { role: 'user', content: '{{reviewPrompt}} Theme: {{theme}}' },
      ],
    };

    const result = resolveTemplate(template, variables);
    expect(result[0].content).toBe('You are a challenge judge.');
    expect(result[1].content).toBe('Rate this image. Theme: sunset landscape');
  });

  it('replaces variables in array content text items', () => {
    const template: ReviewTemplate = {
      messages: [
        {
          role: 'system',
          content: [{ type: 'text', text: 'Prompt: {{systemPrompt}}' }],
        },
      ],
    };

    const result = resolveTemplate(template, variables);
    const content = result[0].content as Array<{ type: 'text'; text: string }>;
    expect(content[0].text).toBe('Prompt: You are a challenge judge.');
  });

  it('replaces variables in array content image_url items', () => {
    const template: ReviewTemplate = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/{{theme}}.png' } }],
        },
      ],
    };

    const result = resolveTemplate(template, variables);
    const content = result[0].content as Array<{
      type: 'image_url';
      image_url: { url: string };
    }>;
    expect(content[0].image_url.url).toBe('https://example.com/sunset landscape.png');
  });

  it('leaves unrecognized variables as-is', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => null);

    const template: ReviewTemplate = {
      messages: [{ role: 'system', content: '{{unknownVar}} and {{systemPrompt}}' }],
    };

    const result = resolveTemplate(template, variables);
    expect(result[0].content).toBe('{{unknownVar}} and You are a challenge judge.');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('{{unknownVar}}'));

    warnSpy.mockRestore();
  });

  it('replaces multiple variables in the same string', () => {
    const template: ReviewTemplate = {
      messages: [{ role: 'user', content: '{{systemPrompt}} | {{reviewPrompt}} | {{theme}}' }],
    };

    const result = resolveTemplate(template, variables);
    expect(result[0].content).toBe(
      'You are a challenge judge. | Rate this image. | sunset landscape'
    );
  });

  it('replaces themeElements variable', () => {
    const template: ReviewTemplate = {
      messages: [
        {
          role: 'user',
          content: 'Theme: {{theme}}\nExpected elements: {{themeElements}}',
        },
      ],
    };

    const result = resolveTemplate(template, variables);
    expect(result[0].content).toBe(
      'Theme: sunset landscape\nExpected elements: warm orange hues, horizon line, golden hour lighting'
    );
  });
});
