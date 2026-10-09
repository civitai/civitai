import { describe, expect, it } from 'vitest';
import { pickNextCrucible } from '~/components/Crucible/judging-next-crucible';

// Server order: createdAt desc, id desc.
const list = [
  { id: 30, createdAt: new Date('2026-10-05') },
  { id: 20, createdAt: new Date('2026-10-03') },
  { id: 10, createdAt: new Date('2026-10-01') },
];

describe('pickNextCrucible', () => {
  it('steps to the crucible after the current one', () => {
    expect(pickNextCrucible(list, list[0])?.id).toBe(20);
    expect(pickNextCrucible(list, list[1])?.id).toBe(10);
  });

  it('wraps from the last crucible to the first', () => {
    expect(pickNextCrucible(list, list[2])?.id).toBe(30);
  });

  it('walks the whole list when repeated', () => {
    const seen: number[] = [];
    let from = list[0];
    for (let i = 0; i < list.length; i++) {
      const next = pickNextCrucible(list, from);
      if (!next) throw new Error('expected a next crucible');
      seen.push(next.id);
      from = next;
    }
    expect(seen).toEqual([20, 10, 30]);
  });

  it('goes to the first older crucible when the current one is not listed', () => {
    expect(pickNextCrucible(list, { id: 25, createdAt: new Date('2026-10-04') })?.id).toBe(20);
  });

  it('orders a createdAt tie by id, as the server does', () => {
    expect(pickNextCrucible(list, { id: 25, createdAt: new Date('2026-10-03') })?.id).toBe(20);
    expect(pickNextCrucible(list, { id: 15, createdAt: new Date('2026-10-03') })?.id).toBe(10);
  });

  it('goes to the first crucible when none listed is older than the current one', () => {
    expect(pickNextCrucible(list, { id: 5, createdAt: new Date('2026-09-01') })?.id).toBe(30);
  });

  it('reads a createdAt that arrives as a string', () => {
    expect(
      pickNextCrucible(list, { id: 25, createdAt: '2026-10-04T00:00:00.000Z' as unknown as Date })
        ?.id
    ).toBe(20);
  });

  it('returns null when the only crucible listed is the current one', () => {
    expect(pickNextCrucible([list[1]], list[1])).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(pickNextCrucible([], list[0])).toBeNull();
  });
});
