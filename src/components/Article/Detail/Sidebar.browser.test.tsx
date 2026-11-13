import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
import type * as CreatorCardModule from '~/components/CreatorCard/CreatorCard';
import { renderWithProviders } from '../../../../test/component-setup';

vi.mock('~/components/CreatorCard/CreatorCard', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorCardModule>()),
  SmartCreatorCard: () => null,
}));

import '~/styles/globals.css';
import { Sidebar } from '~/components/Article/Detail/Sidebar';

const KEY = 'article-active-accordion-v2';
const OLD_KEY = 'article-active-accordion';
const zip = { id: 1, name: 'songs.zip', sizeKB: 2048, url: 'https://example.com/songs.zip' };

async function renderSidebar({ attachments = [zip], width = 1000 } = {}) {
  await page.viewport(width, 800);
  renderWithProviders(
    <div>
      <article>
        <h2 id="intro">Intro</h2>
      </article>
      <Sidebar articleId={1} attachments={attachments as never} creator={{} as never} />
    </div>
  );
  // The contents read the article's headings after mount; on a phone they are drawn but hidden.
  await vi.waitFor(() => expect(document.body.textContent).toContain('Table of Contents'));
}

const expanded = (name: string) =>
  page.getByRole('button', { name }).element().getAttribute('aria-expanded');

afterEach(() => {
  cleanup();
  localStorage.removeItem(KEY);
  localStorage.removeItem(OLD_KEY);
});

describe('article sidebar accordion', () => {
  test('an article with attachments opens them', async () => {
    await renderSidebar();
    expect(expanded('Attachments')).toBe('true');
    expect(expanded('Table of Contents')).toBe('false');
  });

  // The old key's 'toc' was written for every reader who ever opened an article, chosen or not.
  test('a returning reader with the old stored contents still gets the attachments', async () => {
    localStorage.setItem(OLD_KEY, JSON.stringify('toc'));
    await renderSidebar();
    expect(expanded('Attachments')).toBe('true');
  });

  test('without attachments the contents are open', async () => {
    await renderSidebar({ attachments: [] });
    expect(expanded('Table of Contents')).toBe('true');
  });

  test('the item the reader last opened stays open', async () => {
    localStorage.setItem(KEY, JSON.stringify('toc'));
    await renderSidebar();
    expect(expanded('Table of Contents')).toBe('true');
  });

  // On a phone the contents are hidden, so a stored 'toc' left every item there collapsed.
  test('on a phone the hidden contents never hold the open state', async () => {
    localStorage.setItem(KEY, JSON.stringify('toc'));
    await renderSidebar({ width: 400 });
    expect(expanded('Attachments')).toBe('true');
  });
});
