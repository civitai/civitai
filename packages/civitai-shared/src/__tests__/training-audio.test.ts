import { describe, expect, it } from 'vitest';
import { formatYue2SamplePrompt } from '../training-audio';

describe('YuE2 sample prompts', () => {
  it('retains caption and transcribed lyrics without ACE-Step metadata', () => {
    expect(
      formatYue2SamplePrompt(
        '<CAPTION>Soft piano</CAPTION><LYRICS>[Verse]\nHello\nworld</LYRICS><DURATION>30</DURATION><LANGUAGE>en</LANGUAGE>'
      )
    ).toBe('Soft piano\n[Lyrics]\n[Verse]\nHello\nworld');
  });

  it('preserves native prompts, including song sections', () => {
    const prompt = 'Rock\n[Lyrics]\n[Verse 1]\nKeep singing\n[Chorus]\nTogether';
    expect(formatYue2SamplePrompt(prompt)).toBe(prompt);
  });

  it('keeps instrumental captions without introducing lyrics', () => {
    expect(formatYue2SamplePrompt('<CAPTION>Instrumental piano</CAPTION>')).toBe(
      'Instrumental piano'
    );
    expect(formatYue2SamplePrompt('Instrumental piano')).toBe('Instrumental piano');
  });

  it('handles lyrics-only and case-insensitive tagged captions', () => {
    expect(formatYue2SamplePrompt('<lyrics>Words</lyrics>')).toBe('[Lyrics]\nWords');
    expect(formatYue2SamplePrompt('')).toBe('');
  });
});
