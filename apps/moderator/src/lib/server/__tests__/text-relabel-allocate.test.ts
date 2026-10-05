import { describe, expect, it } from 'vitest';
import { REPORT_ENTITIES } from '../report-entities';
import {
  allocate,
  ENTITY_JOINS,
  POOL_QUOTAS,
  WAVE_ONE_QUOTAS,
  waterFill,
  type SnapshotCandidate,
} from '../text-relabel-snapshot';

let nextId = 1;
function pairs(tag: string, n: number, over: Partial<SnapshotCandidate> = {}): SnapshotCandidate[] {
  return Array.from({ length: n }, () => ({
    reportId: nextId++,
    tag,
    confidence: 70,
    flaggedAt: new Date('2026-10-01T00:00:00Z'),
    authorId: 1,
    entityType: 'commentV2',
    entityId: 1,
    ...over,
  }));
}

const count = <T>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;

describe('waterFill', () => {
  it('splits evenly and hands a small cell’s unused share to the others', () => {
    expect(waterFill([100, 3, 100], 30)).toEqual([14, 3, 13]);
  });

  it('takes everything when the quota exceeds the cells', () => {
    expect(waterFill([2, 5], Infinity)).toEqual([2, 5]);
  });

  it('stops at the quota when it is smaller than the number of cells', () => {
    expect(waterFill([4, 4, 4], 2)).toEqual([1, 1, 0]);
  });
});

describe('allocate', () => {
  // Decision: every CSAM pair the window holds is kept; a quota would thin the tag whose precision
  // matters most.
  it('keeps every CSAM pair in the pool', () => {
    const { picks } = allocate(pairs('CSAM', 700), 'seed');
    expect(count(picks, (p) => p.tag === 'CSAM')).toBe(700);
  });

  it('caps the other tags at their pool quota', () => {
    const { picks } = allocate(pairs('Grooming', 900), 'seed');
    expect(count(picks, (p) => p.tag === 'Grooming')).toBe(POOL_QUOTAS.Grooming);
  });

  // Wave 1 is CSAM 50, Grooming 50, Sex Trafficking 30, Exploitation 25, Illegal Trade 25, NSFW 20,
  // and every staff impersonation (five in this fixture).
  it('marks the first wave per tag, inside the pool', () => {
    const all = [
      ...pairs('CSAM', 500),
      ...pairs('Grooming', 500),
      ...pairs('Sex Trafficking', 500),
      ...pairs('Exploitation', 500),
      ...pairs('Illegal Trade', 500),
      ...pairs('NSFW', 500),
      ...pairs('Impersonating Civitai Staff', 5),
    ];
    const { picks } = allocate(all, 'seed');
    const waveOne = picks.filter((p) => p.wave === 1);
    expect(waveOne).toHaveLength(205);
    for (const [tag, quota] of Object.entries(WAVE_ONE_QUOTAS)) {
      const expected = Number.isFinite(quota) ? quota : 5;
      expect([tag, count(waveOne, (p) => p.tag === tag)]).toEqual([tag, expected]);
    }
  });

  it('spreads a tag’s wave across confidence bands and public vs chat', () => {
    const all = [
      ...pairs('CSAM', 300, { confidence: 99 }),
      ...pairs('CSAM', 10, { confidence: 60 }),
      ...pairs('CSAM', 100, { confidence: 85, entityType: 'chat' }),
    ];
    const waveOne = allocate(all, 'seed').picks.filter((p) => p.wave === 1);
    const byStratum = Object.fromEntries(
      ['CSAM|high|public', 'CSAM|low|public', 'CSAM|mid|private'].map((k) => [
        k,
        count(waveOne, (p) => p.stratumKey === k),
      ])
    );
    expect(byStratum).toEqual({
      'CSAM|high|public': 20,
      'CSAM|low|public': 10,
      'CSAM|mid|private': 20,
    });
  });

  it('records each pick’s cell population so the sample can be re-weighted', () => {
    const all = [
      ...pairs('NSFW', 600, { confidence: 99 }),
      ...pairs('NSFW', 4, { confidence: 60 }),
    ];
    const { picks } = allocate(all, 'seed');
    const high = picks.find((p) => p.band === 'high');
    const low = picks.find((p) => p.band === 'low');
    expect([high?.cellPopulation, low?.cellPopulation]).toEqual([600, 4]);
  });

  it('draws the same pairs for the same seed, and different ones for another', () => {
    const all = pairs('Grooming', 1000);
    const ids = (seed: string) =>
      allocate(all, seed)
        .picks.filter((p) => p.wave === 1)
        .map((p) => p.reportId)
        .sort((a, b) => a - b);
    expect(ids('a')).toEqual(ids('a'));
    expect(ids('a')).not.toEqual(ids('b'));
  });

  it('leaves out a tag it has no quota for, and counts it', () => {
    const { picks, unknownTags } = allocate(
      [...pairs('CSAM', 2), ...pairs('Brand New Label', 3)],
      'seed'
    );
    expect(picks.map((p) => p.tag)).toEqual(['CSAM', 'CSAM']);
    expect(unknownTags).toEqual({ 'Brand New Label': 3 });
  });
});

describe('ENTITY_JOINS', () => {
  it('lists exactly the report types the app knows', () => {
    const app = REPORT_ENTITIES.map((e) => [e.reportTable, e.fk, e.type].join(':')).sort();
    expect(ENTITY_JOINS.map((j) => j.join(':')).sort()).toEqual(app);
  });
});
