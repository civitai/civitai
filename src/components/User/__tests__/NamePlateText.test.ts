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

  it('does not sweep, or throw, for an animated gradient plate missing its colours', () => {
    expect(
      getNamePlateTextProps({ variant: 'gradient', animated: true }, { animate: true })
    ).toEqual({ variant: 'gradient' });
  });

  // The class is only a string here; without these keys Tailwind emits no CSS for it.
  it('names an animation the Tailwind config defines', async () => {
    const { theme } = (await import('../../../../tailwind.config.js')).default as {
      theme: { extend: { animation: Record<string, string>; keyframes: Record<string, unknown> } };
    };
    expect(NAMEPLATE_SWEEP_CLASS.split(' ')).toContain('animate-nameplate-sweep');
    expect(theme.extend.animation['nameplate-sweep']).toMatch(
      /^nameplate-sweep 3s linear infinite$/
    );
    expect(theme.extend.keyframes['nameplate-sweep']).toEqual({
      '0%': { backgroundPosition: '0% 50%' },
      '100%': { backgroundPosition: '200% 50%' },
    });
  });

  it('returns nothing to spread for a user without a plate', () => {
    expect(getNamePlateTextProps(undefined, { animate: true })).toEqual({});
  });
});
