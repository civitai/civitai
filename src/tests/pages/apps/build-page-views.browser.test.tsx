import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import Router from 'next/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';

/**
 * `/apps/build`'s RENDER for each view the server can hand it — the half of the gate the SSR
 * matrix (`src/tests/pages/apps/build-page.test.ts`) cannot see. The workspace, the build body and
 * the layout are stand-ins; what is under test is which of them the PAGE mounts, for whom.
 *
 * 🔴 The author switch exists because `/apps/mine` and `/apps/assistant` both 301 here: an author
 * in the assistant view whose app list had no switch would have no route to it at all.
 */

const mocks = vi.hoisted(() => ({
  user: null as null | { id: number; isModerator: boolean },
  flags: {} as Record<string, boolean>,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.flags,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
// Server-only: the page module's `getServerSideProps` is not under test here.
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));
// The site shell, mounted by the page's `getLayout` — not by the component rendered here.
vi.mock('~/components/AppLayout/AppLayout', () => ({
  AppLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('~/components/Apps/AppAssistant/AppAssistantWorkspace', () => ({
  AppAssistantWorkspace: (props: { sandboxUrl: string | null; remoteRunner?: boolean }) => (
    <div
      data-testid="workspace"
      data-sandbox={props.sandboxUrl ?? ''}
      data-remote={String(!!props.remoteRunner)}
    />
  ),
}));
vi.mock('~/components/Apps/AppsBuildBody', () => ({
  AppsBuildBody: () => <div data-testid="build-body" />,
}));
vi.mock('~/components/Apps/AppsPageLayout', () => ({
  AppsPageLayout: ({ actions, children }: { actions?: ReactNode; children: ReactNode }) => (
    <div>
      <div data-testid="actions">{actions}</div>
      {children}
    </div>
  ),
}));

const { default: AppsBuildPage } = await import('~/pages/apps/build');

const ASSISTANT = {
  mode: 'assistant' as const,
  canPreview: false,
  sandboxUrl: 'https://sandbox.example',
  subagents: false,
  remoteRunner: true,
};
const MEMBER = { id: 12, isModerator: false };
const MODERATOR = { id: 2, isModerator: true };

const seen = (testId: string) => page.getByTestId(testId).elements().length;

async function renderPage(props: Parameters<typeof AppsBuildPage>[0]) {
  renderWithProviders(<AppsBuildPage {...props} />);
  await expect.element(page.getByTestId('actions')).toBeInTheDocument();
}

beforeEach(() => {
  mocks.user = MEMBER;
  mocks.flags = {};
  (Router as unknown as { query: Record<string, string> }).query = {};
});

describe('/apps/build — which view the page mounts', () => {
  test('the build view mounts the build body and never the workspace', async () => {
    await renderPage({ mode: 'build' });
    expect(seen('build-body')).toBe(1);
    expect(seen('workspace')).toBe(0);
  });

  test('the assistant view mounts the workspace with the server’s props', async () => {
    await renderPage(ASSISTANT);
    await expect
      .element(page.getByTestId('workspace'))
      .toHaveAttribute('data-sandbox', 'https://sandbox.example');
    await expect.element(page.getByTestId('workspace')).toHaveAttribute('data-remote', 'true');
    expect(seen('build-body')).toBe(0);
  });

  test('a NON-author in the assistant view gets no "My apps" switch, and ?view=apps does nothing', async () => {
    (Router as unknown as { query: Record<string, string> }).query = { view: 'apps' };
    await renderPage(ASSISTANT);
    expect(seen('workspace')).toBe(1);
    expect(seen('apps-build-show-apps')).toBe(0);
    expect(seen('build-body')).toBe(0);
  });

  test('🔴 an author in the assistant view can reach their app list', async () => {
    mocks.flags = { appBlocksAuthor: true };
    await renderPage(ASSISTANT);
    await expect
      .element(page.getByTestId('apps-build-show-apps'))
      .toHaveAttribute('href', '/apps/build?view=apps');
    expect(seen('workspace')).toBe(1);
  });

  test('🔴 …and ?view=apps shows it, with a way back to the assistant', async () => {
    mocks.user = MODERATOR; // moderators are authors by floor
    (Router as unknown as { query: Record<string, string> }).query = { view: 'apps' };
    await renderPage(ASSISTANT);
    expect(seen('build-body')).toBe(1);
    expect(seen('workspace')).toBe(0);
    await expect
      .element(page.getByTestId('apps-build-show-assistant'))
      .toHaveAttribute('href', '/apps/build');
  });
});
