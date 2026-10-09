import { describe, expect, it } from 'vitest';
import { getNamePlateTextProps, NAMEPLATE_SWEEP_CLASS } from '~/components/User/NamePlateText';

const gradient = { from: '#ffd43b', to: '#f59f00', deg: 180 };

describe('getNamePlateTextProps', () => {
  it('passes a static plate through unchanged', () => {
    const data = { variant: 'gradient' as const, gradient };
    expect(getNamePlateTextProps(data, { animate: true })).toEqual(data);
  });

  it('sweeps an animated gradient horizontally as one repeating tile', () => {
    expect(
      getNamePlateTextProps({ variant: 'gradient', gradient, animated: true }, { animate: true })
    ).toEqual({
      variant: 'gradient',
      gradient,
      className: NAMEPLATE_SWEEP_CLASS,
      style: {
        '--text-gradient': 'linear-gradient(90deg, #ffd43b, #f59f00, #ffd43b)',
        backgroundSize: '200% 100%',
      },
    });
  });

  it('holds an animated plate still when the viewer disabled autoplay', () => {
    expect(
      getNamePlateTextProps({ variant: 'gradient', gradient, animated: true }, { animate: false })
    ).toEqual({ variant: 'gradient', gradient });
  });

  it('never forwards `animated`, which is not a Text prop', () => {
    expect(getNamePlateTextProps({ color: 'red', animated: true }, { animate: true })).toEqual({
      color: 'red',
    });
  });

  it('returns nothing to spread for a user without a plate', () => {
    expect(getNamePlateTextProps(undefined, { animate: true })).toEqual({});
  });
});
