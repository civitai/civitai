import { describe, expect, it } from 'vitest';
import { APPEAL_QUEUE_PATHS, appealQueuePath, classifyAppeal } from './appeals';
import { mentionKeys } from './mentions';

const row = {
  entityType: 'Image',
  entityRemovedAt: null as Date | null,
  category: null as string | null,
};

describe('classifyAppeal', () => {
  it('puts each row in exactly one kind: removed, then site form, then model flag, then image', () => {
    const removed = new Date('2026-10-01T00:00:00Z');
    expect(classifyAppeal({ ...row, entityRemovedAt: removed, category: 'Model' })).toBe('removed');
    expect(classifyAppeal({ ...row, entityType: 'Model', category: 'Model' })).toBe('site');
    expect(classifyAppeal({ ...row, entityType: 'Image', category: 'Other' })).toBe('site');
    expect(classifyAppeal({ ...row, entityType: 'Model' })).toBe('modelFlag');
    expect(classifyAppeal(row)).toBe('image');
  });

  it('drops a row of a type no queue shows', () => {
    expect(classifyAppeal({ ...row, entityType: 'Article' })).toBeNull();
  });
});

describe('appealQueuePath', () => {
  it('names the queue whose grant reads each kind', () => {
    expect(appealQueuePath('image', null)).toBe('/images/appeals');
    expect(appealQueuePath('removed', null)).toBe('/images/removed-appeals');
    expect(appealQueuePath('modelFlag', null)).toBe('/models/flags/appeals');
    expect(appealQueuePath('site', 'Account')).toBe('/appeals/account');
    expect(appealQueuePath('site', 'Article')).toBe('/appeals/articles');
    expect(appealQueuePath('site', 'Model')).toBe('/appeals/models');
    expect(appealQueuePath('site', 'Other')).toBe('/appeals/other');
  });

  it('lists every one of them as a grant that reads the panel', () => {
    expect([...APPEAL_QUEUE_PATHS].sort()).toEqual(
      [
        '/appeals/account',
        '/appeals/articles',
        '/appeals/models',
        '/appeals/other',
        '/images/appeals',
        '/images/removed-appeals',
        '/models/flags/appeals',
      ].sort()
    );
  });
});

describe('mentionKeys', () => {
  it('finds image, post and model links in the subject and description', () => {
    const keys = mentionKeys(
      'Image removed https://civitai.com/images/123 and see civitai.red/posts/45?x=1, ' +
        '(https://www.civitai.green/models/6/some-name).'
    );
    expect(keys.images).toEqual(new Set([123]));
    expect(keys.posts).toEqual(new Set([45]));
    expect(keys.models).toEqual(new Set([6]));
  });

  it('ignores other sites, bare numbers and links to other kinds of content', () => {
    const keys = mentionKeys('https://example.com/images/9 id 77 https://civitai.com/articles/3');
    expect(keys.images.size + keys.posts.size + keys.models.size).toBe(0);
  });
});
