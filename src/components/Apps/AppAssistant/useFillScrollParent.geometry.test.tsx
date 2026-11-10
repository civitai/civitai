import { StrictMode } from 'react';
import { describe, expect, test } from 'vitest';
import { nextLayout, renderAtViewport } from '../../../../test/geometry-setup';
import { useFillScrollParent } from '~/components/Apps/AppAssistant/useFillScrollParent';

// The app's `.scroll-area` is a flex container, so every child opts out of shrinking, as the real
// page body does.
const rigid = { flexShrink: 0 } as const;

function Page({ bandHeight, withFill }: { bandHeight: number; withFill: boolean }) {
  const ref = useFillScrollParent<HTMLDivElement>();
  return (
    <div className="scroll-area" style={{ height: 600, overflowY: 'auto' }} data-testid="scroller">
      <div style={{ ...rigid, height: bandHeight }} />
      <div
        ref={withFill ? ref : undefined}
        data-testid="fill"
        style={{ ...rigid, height: 'var(--assistant-fill-height, 900px)' }}
      />
      <div style={{ ...rigid, height: 16 }} />
    </div>
  );
}

const scroller = () => document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
const fill = () => document.querySelector<HTMLElement>('[data-testid="fill"]')!;

describe('useFillScrollParent', () => {
  test.each([40, 140, 260])(
    'leaves the scroller without overflow under a %i px band',
    async (bandHeight) => {
      await renderAtViewport(<Page bandHeight={bandHeight} withFill />);
      expect(scroller().scrollHeight).toBe(scroller().clientHeight);
    }
  );

  test('the same page overflows without the hook', async () => {
    await renderAtViewport(<Page bandHeight={140} withFill={false} />);
    expect(scroller().scrollHeight).toBeGreaterThan(scroller().clientHeight);
  });

  test('grows back when the scroller grows and the window resizes', async () => {
    await renderAtViewport(<Page bandHeight={140} withFill />);
    const before = fill().getBoundingClientRect().height;
    scroller().style.height = '800px';
    window.dispatchEvent(new Event('resize'));
    await nextLayout();
    expect(fill().getBoundingClientRect().height).toBe(before + 200);
    expect(scroller().scrollHeight).toBe(scroller().clientHeight);
  });

  test('grows back when only the scroller is resized, with no window event', async () => {
    await renderAtViewport(<Page bandHeight={140} withFill />);
    const before = fill().getBoundingClientRect().height;
    scroller().style.height = '800px';
    await nextLayout();
    await nextLayout();
    expect(fill().getBoundingClientRect().height).toBe(before + 200);
  });

  test('still follows the scroller after the effects re-run, as in StrictMode', async () => {
    await renderAtViewport(
      <StrictMode>
        <Page bandHeight={140} withFill />
      </StrictMode>
    );
    const before = fill().getBoundingClientRect().height;
    scroller().style.height = '800px';
    await nextLayout();
    await nextLayout();
    expect(fill().getBoundingClientRect().height).toBe(before + 200);
  });
});
