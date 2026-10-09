// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import styles from '~/components/TwCosmeticWrapper/CosmeticWrapper.module.scss';
import { BIRTHDAY_2026_EVENT } from '~/shared/constants/birthday2026.constants';

const HAT = { type: 'hat', event: BIRTHDAY_2026_EVENT, url: 'https://example.com/hat.png' };
const FRAME = { cssFrame: 'linear-gradient(red, blue)' };

function render(props: { cosmetic?: object; eventDecoration?: typeof HAT }) {
  const html = renderToStaticMarkup(
    createElement(
      TwCosmeticWrapper,
      props as never,
      createElement('div', { id: 'card', style: { height: 300 } })
    )
  );
  const root = new DOMParser().parseFromString(html, 'text/html').body.firstElementChild!;
  return { root, hat: root.querySelector('button[data-event-decoration="hat"]') };
}

// The browser-mode screenshots caught this; this is the CI-run pin. The frame layout gives the
// card `flex: 1`, which overrides the card's own height and collapsed every hatted, frameless
// card in the feed. A hat alone must not opt the card into the frame layout.
describe('TwCosmeticWrapper with an event decoration', () => {
  it('a hat alone does not put the card in the frame layout', () => {
    const { root, hat } = render({ eventDecoration: HAT });
    expect(hat).not.toBeNull();
    expect(root.classList.contains(styles.wrapper)).toBe(false);
    expect(root.classList.contains(styles.decorationOnly)).toBe(true);
  });

  it('a hat with a frame keeps the frame layout and draws both', () => {
    const { root, hat } = render({ cosmetic: FRAME, eventDecoration: HAT });
    expect(hat).not.toBeNull();
    expect(root.classList.contains(styles.wrapper)).toBe(true);
    expect(root.classList.contains(styles.cssFrame)).toBe(true);
  });

  it('a hat handed over as the frame by an older reader is drawn as a hat, not a frame', () => {
    const { root, hat } = render({ cosmetic: HAT });
    expect(hat).not.toBeNull();
    expect(root.classList.contains(styles.wrapper)).toBe(false);
  });

  it('leaves an undecorated card untouched', () => {
    const { root } = render({});
    expect(root.id).toBe('card');
  });
});
