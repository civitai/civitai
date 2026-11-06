import { describe, expect, it } from 'vitest';
import { visibleScans, type PromptScan } from '../prompt-scans';

const scan = (id: string, top: number): PromptScan => ({
  id,
  createdAt: '2026-10-27T00:00:00Z',
  prompt: 'p',
  negativePrompt: null,
  scores: [{ label: 'alpha', score: top }],
});
const items = [scan('new', 0.1), scan('mid', 0.9), scan('old', 0.5)];
const ids = (r: PromptScan[]) => r.map((s) => s.id);

describe('visibleScans', () => {
  it('keeps the server order for newest', () => {
    expect(ids(visibleScans(items, { sort: 'newest', minScore: '' }))).toEqual([
      'new',
      'mid',
      'old',
    ]);
  });

  it('orders by the highest score', () => {
    expect(ids(visibleScans(items, { sort: 'score', minScore: '' }))).toEqual([
      'mid',
      'old',
      'new',
    ]);
  });

  it('keeps rows whose highest score reaches the floor', () => {
    expect(ids(visibleScans(items, { sort: 'newest', minScore: '0.5' }))).toEqual(['mid', 'old']);
  });

  it('filters nothing on a blank or non-numeric floor', () => {
    expect(visibleScans(items, { sort: 'newest', minScore: '  ' })).toHaveLength(3);
    expect(visibleScans(items, { sort: 'newest', minScore: 'abc' })).toHaveLength(3);
  });
});
