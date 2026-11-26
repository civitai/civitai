import { describe, expect, it } from 'vitest';
import { withoutMinorAge } from '~/server/services/age-prompt-shadow.service';
import { auditPromptEnriched } from '~/utils/metadata/audit';

const ageHit = (text: string) => auditPromptEnriched(text).triggers[0]?.category === 'minor_age';

describe('withoutMinorAge', () => {
  it('control: the fixtures hit the age check', () => {
    expect(ageHit('portrait of a 14 year old, nude')).toBe(true);
    expect(ageHit('caged 145 birds, aged 14')).toBe(true);
  });

  it('isolates an age hit beside an nsfw word, so the classifier can decide it', () => {
    const rest = withoutMinorAge('portrait of a 14 year old, nude');
    expect(rest).toBeDefined();
    expect(rest).toContain('nude');
    expect(ageHit(rest as string)).toBe(false);
  });

  it('cuts the age match, not the same characters inside a longer word', () => {
    expect(withoutMinorAge('caged 145 birds, aged 14')).toContain('caged 145 birds');
  });

  it('returns the rest of the raw prompt, not a normalized copy', () => {
    expect(withoutMinorAge('a 14 year old &amp; a dog')).toContain('&amp;');
  });
});
