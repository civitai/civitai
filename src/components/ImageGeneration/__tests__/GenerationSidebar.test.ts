import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type * as ResourceResidency from '~/components/ResourceLoad/ResourceResidency';
import type * as GenerationPanelStore from '~/store/generation-panel.store';
import { GenerationSidebar } from '~/components/ImageGeneration/GenerationSidebar';

const router = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/router', () => ({ useRouter: () => router }));
// renderToString reads a zustand store's INITIAL state, so setState can't open the panel.
vi.mock('~/store/generation-panel.store', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationPanelStore>()),
  useGenerationPanelStore: (select: (state: { opened: boolean }) => unknown) =>
    select({ opened: true }),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('~/components/ResourceLoad/ResourceResidency', async (importOriginal) => ({
  ...(await importOriginal<typeof ResourceResidency>()),
  useRefreshResidencyOnOpen: vi.fn(),
}));

const renderAt = (pathname: string) => {
  router.pathname = pathname;
  return renderToString(createElement(GenerationSidebar));
};

describe('GenerationSidebar', () => {
  it('renders the open panel on an ordinary page', () => {
    expect(renderAt('/models')).toContain('data-tour="gen:start"');
  });

  it('stays out of /generate even when opened', () => {
    expect(renderAt('/generate')).toBe('');
  });
});
