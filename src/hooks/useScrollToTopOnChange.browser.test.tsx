import React, { useRef, useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ScrollAreaContext } from '~/components/ScrollArea/ScrollAreaContext';
import { useScrollToTopOnChange } from '~/hooks/useScrollToTopOnChange';
import { renderWithProviders } from '../../test/component-setup';

// A new image search swapped its results in place, leaving the viewer far below the best match
// (tester report, fxlhx6vrqavz). Browser mode because the assertions are real scroll positions.

function Results({ searchKey, pages }: { searchKey: string | undefined; pages: number }) {
  useScrollToTopOnChange(searchKey);
  return <div data-pages={pages} style={{ height: 3000 }} />;
}

function Harness() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [searchKey, setSearchKey] = useState<string | undefined>('cat');
  const [pages, setPages] = useState(1);

  return (
    <>
      <button onClick={() => setSearchKey('dog')}>search dog</button>
      <button onClick={() => setPages((count) => count + 1)}>next page</button>
      <ScrollAreaContext.Provider value={{ ref: scrollRef as React.RefObject<HTMLDivElement> }}>
        <div ref={scrollRef} data-testid="scroll-area" style={{ height: 200, overflowY: 'auto' }}>
          <Results searchKey={searchKey} pages={pages} />
        </div>
      </ScrollAreaContext.Provider>
    </>
  );
}

const scrollArea = () => document.querySelector('[data-testid="scroll-area"]') as HTMLElement;

describe('useScrollToTopOnChange', () => {
  test('a new search scrolls the results back to the top', async () => {
    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId('scroll-area')).toBeInTheDocument();
    scrollArea().scrollTop = 1500;
    expect(scrollArea().scrollTop).toBe(1500);

    await userEvent.click(page.getByRole('button', { name: 'search dog' }));

    await vi.waitFor(() => expect(scrollArea().scrollTop).toBe(0));
  });

  test('re-rendering the same search keeps the scroll position', async () => {
    // Loading the next page re-renders the list with the same key; it must not jump to the top.
    renderWithProviders(<Harness />);
    await expect.element(page.getByTestId('scroll-area')).toBeInTheDocument();
    scrollArea().scrollTop = 1500;

    await userEvent.click(page.getByRole('button', { name: 'next page' }));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-pages]')?.getAttribute('data-pages')).toBe('2')
    );

    expect(scrollArea().scrollTop).toBe(1500);
  });
});
