import { describe, expect, it } from 'vitest';
import {
  blocked,
  blockedNSFW,
  blockedNSFWOverridable,
  poiWords,
} from '@civitai/mod-utils/prompt-audit/lists';
import { auditPostImageMeta, auditPromptEnriched } from '~/utils/metadata/audit';
import { auditImageMeta } from '~/utils/media-preprocessors/image.preprocessor';

/**
 * Adding an image to a post must not block a prompt the generator would let a user click through,
 * and must keep blocking everything else exactly as before. Words come from the lists themselves.
 */

const overridable = new Set(blockedNSFWOverridable);
const plain = (word: string) => /^[a-z]+$/.test(word);
const pick = (list: string[], soft: boolean) => {
  const word = list.find((w) => plain(w) && overridable.has(w) === soft);
  if (!word) throw new Error(`no ${soft ? 'soft' : 'hard'} word on this list`);
  return word;
};

// A real-person name the generator's own audit refuses outright.
const person = poiWords.find(
  (w) => /^[a-z ]+$/.test(w) && auditPromptEnriched(w).triggers[0]?.category === 'poi'
);
if (!person) throw new Error('no real-person name to test with');

const lists = [
  { name: 'SFW list', nsfw: false, list: blocked },
  { name: 'NSFW list', nsfw: true, list: blockedNSFW },
];

describe.each(lists)('auditPostImageMeta on the $name', ({ nsfw, list }) => {
  const soft = pick(list, true);
  const hard = pick(list, false);

  it('lets a prompt through when every match is overridable', () => {
    const audit = auditPostImageMeta({ prompt: `a sign that says ${soft}` }, nsfw);
    expect(audit).toMatchObject({ success: true, blockedFor: [], softBlockedFor: [soft] });
  });

  it('blocks when an overridable match sits beside a hard one', () => {
    const audit = auditPostImageMeta({ prompt: `${soft}, ${hard}` }, nsfw);
    expect(audit.success).toBe(false);
    expect(audit.blockedFor).toEqual(expect.arrayContaining([soft, hard]));
  });

  it('blocks a hard match alone', () => {
    const audit = auditPostImageMeta({ prompt: `a ${hard}` }, nsfw);
    expect(audit).toMatchObject({ success: false, blockedFor: [hard] });
  });

  it('blocks an overridable match beside a check the generator treats as hard', () => {
    const audit = auditPostImageMeta({ prompt: `${soft}, ${person}` }, nsfw);
    expect(audit).toMatchObject({ success: false, blockedFor: [soft] });
  });

  it('blocks an overridable match beside a minor age', () => {
    expect(auditPostImageMeta({ prompt: `${soft}, a 10 year old` }, nsfw).success).toBe(false);
  });

  it('the upload preprocessor reaches the same verdict', async () => {
    for (const prompt of [soft, `${soft}, ${hard}`, hard, `${soft}, ${person}`, 'a quiet lake']) {
      const { blockedFor } = await auditImageMeta({ prompt }, nsfw);
      expect(!!blockedFor, prompt).toBe(!auditPostImageMeta({ prompt }, nsfw).success);
    }
  });
});

describe('the minor-age check has no override', () => {
  it('blocks an NSFW prompt with a minor age even when the only list match is overridable', () => {
    const soft = pick(blockedNSFW, true);
    const audit = auditPostImageMeta({ prompt: `${soft}, a 10 year old` }, true);
    expect(audit).toMatchObject({ success: false, blockedFor: ['10 year old'] });
  });
});

describe('the SFW list has no severity of its own', () => {
  // The upload decides an SFW-list match with the NSFW list's overridable set. A word added as
  // overridable without being on the NSFW list would make that lookup silently disagree.
  it('every overridable word on the SFW list is also on the NSFW list', () => {
    const nsfwList = new Set(blockedNSFW);
    expect(blocked.filter((w) => overridable.has(w) && !nsfwList.has(w))).toEqual([]);
  });
});
