import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import { NAMEPLATE_SWEEP_CLASS } from '~/components/User/NamePlateText';

// The component test project does not load Tailwind, so the class is compiled here with the repo's
// own config: a typo in the variant would leave the sweep running off screen and break nothing else.
async function compile(classes: string) {
  const config = (await import('../../../../tailwind.config.js')).default;
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw: classes }], corePlugins: { preflight: false } }),
  ]).process('@tailwind utilities;', { from: undefined });
  return result.css;
}

describe('animated nameplate sweep CSS', () => {
  it('pauses the sweep while the node is marked offscreen, and only then', async () => {
    const css = await compile(NAMEPLATE_SWEEP_CLASS);
    const paused = css.match(/([^{}]*)\{[^{}]*animation-play-state:\s*paused[^{}]*\}/);
    expect(paused?.[1]).toContain('[data-offscreen="true"]');
    // The sweep itself is still emitted, so an on-screen plate keeps animating.
    expect(css).toContain('animation: nameplate-sweep 3s linear infinite');
  });

  it('leaves the sweep running for a plate that is not marked', async () => {
    const css = await compile('animate-nameplate-sweep');
    expect(css).not.toContain('animation-play-state');
  });
});
