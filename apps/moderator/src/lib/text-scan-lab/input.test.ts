import { describe, expect, it } from 'vitest';
import { MAX_INPUT_IDS, parseCheckInput } from './input';

describe('parseCheckInput', () => {
  it('reads blank input as empty', () => {
    expect(parseCheckInput('  \n ')).toEqual({ kind: 'empty' });
  });

  it.each([
    ['https://civitai.com/models/123', 'Model', 123],
    ['https://civitai.com/models/123/some-slug?modelVersionId=9', 'Model', 123],
    ['https://www.civitai.com/models/123', 'Model', 123],
    ['https://civitai.red/articles/45/title', 'Article', 45],
    ['https://civitai.green/posts/7', 'Post', 7],
    ['http://localhost:3000/bounties/8/my-bounty', 'Bounty', 8],
    ['https://civitai.com/bounties/8/entries/99', 'BountyEntry', 99],
    ['https://civitai.com/bounties/entries/99', 'BountyEntry', 99],
    ['https://civitai.com/challenges/12', 'Challenge', 12],
    ['https://civitai.com/collections/34', 'Collection', 34],
    ['https://civitai.com/crucibles/56/name', 'Crucible', 56],
    ['https://civitai.com/comments/v2/78', 'CommentV2', 78],
    ['https://civitai.com/models/1?dialog=commentThread&highlight=55', 'Comment', 55],
    ['civitai.com/models/123', 'Model', 123],
    ['https://civitai.com/models/1.', 'Model', 1],
    ['(civitai.com/posts/2)', 'Post', 2],
  ])('recognises %s', (url, entityType, id) => {
    expect(parseCheckInput(`  ${url}  `)).toEqual({ kind: 'entity', entityType, ids: [id] });
  });

  it('collects several links of one kind, de-duplicated', () => {
    expect(
      parseCheckInput(
        'https://civitai.com/models/1\nhttps://civitai.red/models/2, civitai.com/models/1'
      )
    ).toEqual({ kind: 'entity', entityType: 'Model', ids: [1, 2] });
  });

  it('refuses links to different kinds of content together', () => {
    expect(parseCheckInput('https://civitai.com/models/1 https://civitai.com/posts/2')).toEqual({
      kind: 'refused',
      notice: expect.any(String),
    });
  });

  it('returns a profile link as a username to resolve', () => {
    expect(parseCheckInput('https://civitai.com/user/Some%20One/models')).toEqual({
      kind: 'user',
      username: 'Some One',
    });
  });

  it('refuses two different profiles', () => {
    expect(parseCheckInput('civitai.com/user/a civitai.com/user/b')).toEqual({
      kind: 'refused',
      notice: expect.any(String),
    });
  });

  it.each([
    'https://civitai.com/images/123',
    'https://civitai.com/challenges/events/3',
    'https://civitai.com/models',
    'https://civitai.com/user/vault',
    'https://civitai.com/user/account/settings',
    'https://example.com/models/123',
    'https://civitai.com.evil.example/models/1',
  ])('treats %s as an unknown link, judged as text', (url) => {
    expect(parseCheckInput(url)).toEqual({
      kind: 'unknown-url',
      text: url,
      notice: expect.any(String),
    });
  });

  it('reads bare numbers as ids, de-duplicated', () => {
    expect(parseCheckInput('1, 2\n3 2')).toEqual({ kind: 'ids', ids: [1, 2, 3] });
  });

  it(`caps ids at ${MAX_INPUT_IDS}`, () => {
    const ids = Array.from({ length: MAX_INPUT_IDS }, (_, i) => i + 1);
    expect(parseCheckInput(ids.join(','))).toEqual({ kind: 'ids', ids });
    expect(parseCheckInput([...ids, 999].join(','))).toEqual({
      kind: 'too-many-ids',
      count: MAX_INPUT_IDS + 1,
      max: MAX_INPUT_IDS,
    });
  });

  it('reads numbers that cannot be ids as text', () => {
    expect(parseCheckInput('0')).toEqual({ kind: 'text', text: '0' });
    expect(parseCheckInput('99999999999')).toEqual({ kind: 'text', text: '99999999999' });
  });

  it('reads anything else as trimmed text, including text containing a link', () => {
    expect(parseCheckInput('  buy cheap buzz at https://civitai.com/models/1 \n')).toEqual({
      kind: 'text',
      text: 'buy cheap buzz at https://civitai.com/models/1',
    });
    expect(parseCheckInput('hello 123')).toEqual({ kind: 'text', text: 'hello 123' });
  });
});
