import { describe, expect, it } from 'vitest';
import { partitionResolutions, type Resolution } from '../decision-resolution.service';

const at = new Date(0);
const r = (itemKey: string, subKey: string, ruling: string): Resolution => ({
  id: `${itemKey}:${subKey}`,
  itemKey,
  subKey,
  ruling: ruling as Resolution['ruling'],
  targetKey: null,
  escalateTo: null,
  note: null,
  ruledBy: 1,
  ruledAt: at,
  applyState: 'n/a',
});

describe('partitionResolutions', () => {
  it("splits sub_key '' (the whole item) from member labels, per item", () => {
    const { groups, members } = partitionResolutions([
      r('g0', '', 'park'),
      r('g0', '17', 'belongs'),
      r('g1', '18', 'unsure'),
    ]);
    expect([...groups.keys()]).toEqual(['g0']);
    expect(groups.get('g0')?.ruling).toBe('park');
    expect(members.get('g0')).toEqual({ '17': { ruling: 'belongs', ruledBy: 1, ruledAt: at } });
    expect(members.get('g1')).toEqual({ '18': { ruling: 'unsure', ruledBy: 1, ruledAt: at } });
  });

  it('files resolved as a GROUP ruling, carrying its row id', () => {
    const { groups, members } = partitionResolutions([r('g2', '', 'resolved')]);
    expect(groups.get('g2')).toMatchObject({ id: 'g2:', ruling: 'resolved' });
    expect(members.size).toBe(0);
  });

  it('drops a row whose ruling kind does not fit its scope rather than mis-filing it', () => {
    const { groups, members } = partitionResolutions([
      r('g0', '', 'belongs'),
      r('g0', '9', 'park'),
    ]);
    expect(groups.size).toBe(0);
    expect(members.size).toBe(0);
  });
});
