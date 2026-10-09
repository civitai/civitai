import { describe, expect, it } from 'vitest';
import { hasTipEligibleSelection } from '~/components/form-graph/generation/creator-tip';

const exempt = (id: number) => ({ id, tipsEnabled: false });
const eligible = (id: number) => ({ id, tipsEnabled: true });

describe('hasTipEligibleSelection', () => {
  it('is false with nothing selected', () => {
    expect(hasTipEligibleSelection({}, [eligible(1)])).toBe(false);
  });

  it('is false when the only selected resource is exempt', () => {
    expect(hasTipEligibleSelection({ model: { id: 1 } }, [exempt(1)])).toBe(false);
  });

  it('is true when an added resource is eligible though the checkpoint is exempt', () => {
    expect(
      hasTipEligibleSelection({ model: { id: 1 }, resources: [{ id: 2 }] }, [
        exempt(1),
        eligible(2),
      ])
    ).toBe(true);
  });

  it('counts the VAE', () => {
    expect(
      hasTipEligibleSelection({ model: { id: 1 }, vae: { id: 3 } }, [exempt(1), eligible(3)])
    ).toBe(true);
  });

  it('ignores loaded data for resources that are not selected', () => {
    expect(hasTipEligibleSelection({ model: { id: 1 } }, [exempt(1), eligible(2)])).toBe(false);
  });

  it('treats a selected resource whose data has not loaded as eligible', () => {
    expect(hasTipEligibleSelection({ model: { id: 1 } }, [])).toBe(true);
  });
});
