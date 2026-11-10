import React, { useEffect, useRef } from 'react';
import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { useSearchFocusHotkeys } from '~/hooks/useSearchFocusHotkeys';
import { renderWithProviders } from '../../test/component-setup';

// Browser mode: the bug only exists with a real shadow root, which retargets `event.target` to
// its host by the time the document-level listener sees the keydown.

/** A textarea inside a shadow root, as `<civitai-chat>` renders its composer. */
function ShadowTextarea() {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || host.shadowRoot) return;
    const area = document.createElement('textarea');
    area.setAttribute('aria-label', 'shadow composer');
    host.attachShadow({ mode: 'open' }).appendChild(area);
  }, []);
  return <div ref={hostRef} data-testid="shadow-host" />;
}

function Harness() {
  const searchRef = useRef<HTMLInputElement>(null);
  useSearchFocusHotkeys(() => searchRef.current?.focus());
  return (
    <>
      <input ref={searchRef} aria-label="site search" />
      <ShadowTextarea />
      <button type="button">elsewhere</button>
    </>
  );
}

function shadowTextarea() {
  const host = page.getByTestId('shadow-host').element() as HTMLElement;
  return host.shadowRoot!.querySelector('textarea')!;
}

describe('useSearchFocusHotkeys', () => {
  test('a "/" typed in a textarea inside a shadow root stays in the text', async () => {
    await renderWithProviders(<Harness />);
    await expect.element(page.getByRole('button', { name: 'elsewhere' })).toBeInTheDocument();
    const area = shadowTextarea();
    area.focus();
    await userEvent.keyboard('do this / that');
    expect(area.value).toBe('do this / that');
    expect(document.activeElement).not.toBe(
      page.getByRole('textbox', { name: 'site search' }).element()
    );
  });

  test('"/" outside any field still focuses the search, and is not typed', async () => {
    await renderWithProviders(<Harness />);
    await expect.element(page.getByRole('button', { name: 'elsewhere' })).toBeInTheDocument();
    (page.getByRole('button', { name: 'elsewhere' }).element() as HTMLElement).focus();
    await userEvent.keyboard('/');
    const search = page.getByRole('textbox', { name: 'site search' }).element() as HTMLInputElement;
    expect(document.activeElement).toBe(search);
    expect(search.value).toBe('');
  });
});
