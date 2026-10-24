import { expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../define';
import type { CivitaiPostPlanner } from '../civitai-post-planner';
import type { PlannerHost, PlannerPost } from '../host';

it('shots', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 9, 12, 0));
  await page.viewport(1280, 900);
  document.documentElement.setAttribute('data-civitai-theme', 'dark');
  document.body.style.background = '#1a1b1e';
  const models: [number, string, string][] = [
    [3370248, 'SumiInk', 'krea2_v1.0'],
    [3403974, 'Magneton', 'ani_v1.0'],
    [3387042, "Chumple's Krea Styles", 'Flatso Krea2 v1.0'],
  ];
  const posts: PlannerPost[] = Array.from({ length: 12 }, (_, i) => {
    const [vid, name, versionName] = models[i % 3];
    return {
      id: i + 1,
      title: `Post ${i + 1}`,
      publishedAt: new Date(2026, 9, 10 + Math.floor(i / 2), 9 + (i % 2) * 5, 0).toISOString(),
      modelVersionId: vid,
      nsfwLevel: 1,
      imageCount: 1,
      cover: null,
      release: null,
      model: { name, versionName },
    };
  });
  const host: PlannerHost = {
    backend: {
      getScheduled: async () => ({ posts, dailyLimit: 20, minGapMinutes: 30, truncated: false }),
      getPostDetail: vi.fn(),
      reschedule: vi.fn(),
      publishNow: vi.fn(),
      unschedule: vi.fn(),
      shift: vi.fn(),
    } as unknown as PlannerHost['backend'],
    config: { imageLocation: 'https://img.test', browsingLevel: 1, composerAvailable: false },
    hrefFor: (loc) => `/calendar?view=${loc.view}&anchor=${loc.anchor}`,
    navigate: vi.fn(async () => undefined),
    notify: vi.fn(),
    editPostUrl: (p) => `/posts/${p.id}/edit`,
    viewPostUrl: (p) => `/posts/${p.id}`,
    modelPageUrl: (r) => `/models/${r.modelId}`,
  };
  const el = document.createElement('civitai-post-planner') as CivitaiPostPlanner;
  el.host = host;
  el.location = { view: 'month', anchor: '2026-10-01' };
  document.body.append(el);
  await expect.element(page.getByText('Post 1', { exact: true }).first()).toBeInTheDocument().catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  await userEvent.click(page.getByLabelText('Model'));
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: '../../../../.foreman/shots/model-filter-names.png' });
  await userEvent.keyboard('{Escape}');
  await userEvent.click(page.getByRole('button', { name: 'Select', exact: true }));
  await userEvent.click(page.getByRole('button', { name: /^Select all/ }));
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: '../../../../.foreman/shots/select-all-bulk-bar.png' });
});
