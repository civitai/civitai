import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../define';
import type { CivitaiPostPlanner } from '../civitai-post-planner';
import type {
  PlannerHost,
  PlannerLocation,
  PlannerPost,
  PlannerPostDetail,
  ScheduledRange,
} from '../host';
import { HOUR_HEIGHT_PX } from '../model/hour-grid';

// Dates are faked, so the fixture is a fixed week: "today" is Fri Oct 9 2026 at noon and the
// posts sit on the 10th and 11th. Only Date is faked; timers stay real so Lit's update cycle and
// `expect.element` polling run normally.
const NOW = new Date(2026, 9, 9, 12, 0);
const at = (day: number, hour: number, minute: number) => new Date(2026, 9, day, hour, minute);

const POST_A = at(10, 15, 7);
const POST_B = at(11, 9, 5);

const post = (id: number, when: Date, extra: Partial<PlannerPost> = {}): PlannerPost => ({
  id,
  title: null,
  publishedAt: when.toISOString(),
  modelVersionId: null,
  nsfwLevel: 1,
  imageCount: 3,
  cover: null,
  release: null,
  model: null,
  ...extra,
});

function fakeHost(initial: PlannerPost[]) {
  const posts = initial.map((p) => ({ ...p }));
  const find = (id: number) => posts.find((p) => p.id === id)!;
  const backend = {
    getScheduled: vi.fn(
      async (): Promise<ScheduledRange> => ({
        posts: posts.map((p) => ({ ...p })),
        dailyLimit: 6,
        minGapMinutes: 30,
        truncated: false,
      })
    ),
    getPostDetail: vi.fn(
      async (id: number): Promise<PlannerPostDetail> => ({
        ...find(id),
        description: null,
        media: [1, 2, 3].map((n) => ({
          id: id * 10 + n,
          url: `media-${id}-${n}`,
          type: 'image' as const,
          nsfwLevel: 1,
          width: 100,
          height: 100,
        })),
        model: null,
        resources: [],
        tools: [],
        techniques: [],
        tags: [],
        stats: null,
      })
    ),
    reschedule: vi.fn(async ({ id, publishedAt }: { id: number; publishedAt: string }) => {
      find(id).publishedAt = publishedAt;
      return { publishedAt, scope: 'post' as const, movedPostIds: [] };
    }),
    publishNow: vi.fn(),
    unschedule: vi.fn(async (ids: number[]) => ({ unscheduledIds: ids, skippedReleaseIds: [] })),
    shift: vi.fn(async ({ ids, deltaMinutes }: { ids: number[]; deltaMinutes: number }) => ({
      moved: ids.map((id) => {
        const target = find(id);
        target.publishedAt = new Date(
          Date.parse(target.publishedAt) + deltaMinutes * 60_000
        ).toISOString();
        return { id, publishedAt: target.publishedAt };
      }),
      skippedReleaseIds: [],
    })),
  };
  const host: PlannerHost = {
    backend,
    config: { imageLocation: 'https://img.test', browsingLevel: 1, composerAvailable: false },
    hrefFor: (loc) => `/calendar?view=${loc.view}&anchor=${loc.anchor}`,
    navigate: vi.fn(async () => undefined),
    notify: vi.fn(),
    editPostUrl: (p) => `/posts/${p.id}/edit`,
    viewPostUrl: (p) => `/posts/${p.id}`,
    modelPageUrl: (r) => `/models/${r.modelId}`,
  };
  return { host, backend };
}

async function mount(
  location: PlannerLocation,
  posts: PlannerPost[] = [post(1, POST_A), post(2, POST_B)],
  ready: () => ReturnType<typeof page.getByRole> = chipA
) {
  const { host, backend } = fakeHost(posts);
  const el = document.createElement('civitai-post-planner') as CivitaiPostPlanner;
  el.host = host;
  el.location = location;
  document.body.append(el);
  await expect.element(ready()).toBeInTheDocument();
  return { el, host, backend };
}

const chipA = () => page.getByRole('button', { name: /^3:07 PM, untitled/ });
const chipB = () => page.getByRole('button', { name: /^9:05 AM, untitled/ });

describe('<civitai-post-planner>', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await page.viewport(1280, 900);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('drags a chip across days in month view and reschedules it on the snapped time', async () => {
    const { backend } = await mount({ view: 'month', anchor: '2026-10-01' });

    await userEvent.dragAndDrop(
      chipA(),
      page.getByRole('gridcell', { name: 'Monday, October 12' })
    );

    await vi.waitFor(() => expect(backend.reschedule).toHaveBeenCalledTimes(1));
    expect(backend.reschedule).toHaveBeenCalledWith({
      id: 1,
      publishedAt: at(12, 15, 5).toISOString(),
      expectedScope: 'post',
    });
  });

  it('drops onto an hour-grid column at the five-minute mark under the pointer', async () => {
    const { backend } = await mount({ view: 'week', anchor: '2026-10-11' }, undefined, chipB);
    const column = page.getByLabelText('Monday, October 12');
    // 6 AM is row 0, so 9:25 sits (3 + 25/60) hours down; two extra pixels land inside the mark.
    const y = Math.round((3 + 25 / 60) * HOUR_HEIGHT_PX) + 2;

    await userEvent.dragAndDrop(chipB(), column, { targetPosition: { x: 20, y } });

    await vi.waitFor(() => expect(backend.reschedule).toHaveBeenCalledTimes(1));
    expect(backend.reschedule).toHaveBeenCalledWith({
      id: 2,
      publishedAt: at(12, 9, 25).toISOString(),
      expectedScope: 'post',
    });
  });

  it('nudges a focused chip a day forward on Shift+ArrowRight', async () => {
    const { backend } = await mount({ view: 'month', anchor: '2026-10-01' });

    (chipA().element() as HTMLElement).focus();
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');

    await vi.waitFor(() => expect(backend.reschedule).toHaveBeenCalledTimes(1));
    expect(backend.reschedule.mock.calls[0][0]).toMatchObject({
      id: 1,
      publishedAt: at(11, 15, 7).toISOString(),
    });
  });

  it('opens the lightbox from the drawer strip and pages it with ArrowRight', async () => {
    const { el } = await mount({ view: 'month', anchor: '2026-10-01' });

    await userEvent.click(chipA());
    await userEvent.click(page.getByRole('button', { name: 'Open item 1 of 3' }));
    expect(el._lightbox).toBe(0);
    await expect.element(page.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{ArrowRight}');
    expect(el._lightbox).toBe(1);
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(el._lightbox).toBe(2);
  });

  it('widens the day grid to show a 3 AM post without touching the hour range', async () => {
    const early = post(3, at(10, 3, 0));
    await mount({ view: 'day', anchor: '2026-10-10' }, [post(1, POST_A), early], () =>
      page.getByRole('button', { name: /^3:00 AM, untitled/ })
    );

    expect(page.getByRole('button', { name: 'Show all hours' }).elements()).toHaveLength(1);
    const chip = page.getByRole('button', { name: /^3:00 AM, untitled/ }).element();
    const column = page.getByLabelText('Saturday, October 10').element();
    const top = chip.getBoundingClientRect().top - column.getBoundingClientRect().top;
    expect(Math.round(top)).toBe(0);
  });

  it('offers Undo after a move, and Undo reschedules back to the original time', async () => {
    const { backend } = await mount({ view: 'month', anchor: '2026-10-01' });

    (chipA().element() as HTMLElement).focus();
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await vi.waitFor(() => expect(backend.reschedule).toHaveBeenCalledTimes(1));

    // The bar removes itself after its window; await only its arrival, never its departure.
    await userEvent.click(page.getByRole('button', { name: 'Undo' }));

    await vi.waitFor(() => expect(backend.reschedule).toHaveBeenCalledTimes(2));
    expect(backend.reschedule.mock.calls[1][0]).toMatchObject({
      id: 1,
      publishedAt: POST_A.toISOString(),
    });
  });

  it('renders the month as a day list on a narrow screen', async () => {
    await page.viewport(390, 844);
    await mount({ view: 'month', anchor: '2026-10-01' }, undefined, () =>
      page.getByRole('heading', { name: /Sat, Oct 10/ })
    );

    expect(page.getByRole('grid').elements()).toHaveLength(0);
    expect(page.getByRole('heading', { name: /Sun, Oct 11/ }).elements()).toHaveLength(1);
    expect(page.getByRole('button', { name: 'Filters' }).elements()).toHaveLength(1);
  });

  it('previews a Shift ± against the loaded range and applies it through backend.shift', async () => {
    const { backend } = await mount({ view: 'month', anchor: '2026-10-01' });

    await userEvent.click(page.getByRole('button', { name: 'Select' }));
    await userEvent.click(chipA());
    await userEvent.click(chipB());
    await userEvent.click(page.getByRole('button', { name: 'Shift ±…' }));

    await expect.element(page.getByText('Oct 10–11 → Oct 11–12 · 0 conflicts')).toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'One more' }));
    await expect.element(page.getByText('Oct 10–11 → Oct 12–13 · 0 conflicts')).toBeInTheDocument();

    await userEvent.click(page.getByRole('button', { name: 'Apply' }));

    await vi.waitFor(() => expect(backend.shift).toHaveBeenCalledTimes(1));
    expect(backend.shift).toHaveBeenCalledWith({ ids: [1, 2], deltaMinutes: 2880 });
  });

  it('moves selected posts to a day one reschedule each, keeping their time of day', async () => {
    const { backend } = await mount({ view: 'month', anchor: '2026-10-01' });

    await userEvent.click(page.getByRole('button', { name: 'Select' }));
    await userEvent.click(chipA());
    await userEvent.click(chipB());
    await userEvent.click(page.getByRole('button', { name: 'Move to day…' }));

    const day = page.getByLabelText('Day', { exact: true });
    await userEvent.fill(day, '2026-10-14');
    await expect.element(page.getByText('Oct 10–11 → Oct 14 · 0 conflicts')).toBeInTheDocument();

    await userEvent.click(page.getByRole('button', { name: 'Move', exact: true }));

    await vi.waitFor(() => expect(backend.reschedule).toHaveBeenCalledTimes(2));
    expect(backend.reschedule.mock.calls.map((call) => call[0].publishedAt).sort()).toEqual(
      [at(14, 15, 7), at(14, 9, 5)].map((d) => d.toISOString()).sort()
    );
    expect(backend.shift).not.toHaveBeenCalled();
  });

  it('selects every standalone scheduled post at once and unschedules them together', async () => {
    const release = { scope: 'version' as const, modelName: 'Model', versionName: 'v1' };
    const { backend } = await mount({ view: 'month', anchor: '2026-10-01' }, [
      post(1, POST_A),
      post(2, POST_B),
      post(3, at(12, 10, 0), { modelVersionId: 5, release }),
    ]);

    await userEvent.click(page.getByRole('button', { name: 'Select' }));
    await userEvent.click(page.getByRole('button', { name: 'Select all 2' }));
    await expect.element(page.getByText('2 selected')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Select all 2' })).toBeDisabled();

    await userEvent.click(page.getByRole('button', { name: 'Unschedule to drafts' }));
    await userEvent.click(page.getByRole('button', { name: 'Unschedule', exact: true }));

    await vi.waitFor(() => expect(backend.unschedule).toHaveBeenCalledTimes(1));
    expect(backend.unschedule).toHaveBeenCalledWith([1, 2]);
  });

  it('keeps the drawer prev/next controls in the header and focus on the one pressed', async () => {
    const { el } = await mount({ view: 'month', anchor: '2026-10-01' }, [
      post(1, POST_A),
      post(2, POST_B),
      post(3, at(12, 18, 0)),
    ]);
    const detail = el.host!.backend.getPostDetail;
    el.host!.backend.getPostDetail = vi.fn(async (id: number) => ({
      ...(await detail(id)),
      description: id === 1 ? 'short' : 'long\n'.repeat(80),
    }));
    const control = (label: string) =>
      el.renderRoot.querySelector<HTMLElement>(`.drawer-head [aria-label="${label}"]`)!;

    await userEvent.click(chipA());
    const next = page.getByRole('button', { name: 'Next post' });
    await expect.element(next).toBeInTheDocument();
    const before = control('Next post').getBoundingClientRect().top;

    await userEvent.click(next);
    await vi.waitFor(() => expect(el._selectedId).toBe(2));
    await expect.element(page.getByText(/long/)).toBeInTheDocument();
    expect(control('Next post').getBoundingClientRect().top).toBe(before);
    expect(el.shadowRoot!.activeElement).toBe(control('Next post'));

    await userEvent.click(next);
    await vi.waitFor(() => expect(el._selectedId).toBe(3));
    expect(control('Next post').hasAttribute('disabled')).toBe(true);
    expect(el.shadowRoot!.activeElement).toBe(control('Close'));
  });

  it('filters by a tag clicked in the drawer, shows it in the toolbar and clears it', async () => {
    const { el, host, backend } = await mount({ view: 'month', anchor: '2026-10-01' });
    backend.getPostDetail.mockImplementationOnce(async (id: number) => ({
      ...(await backend.getPostDetail.getMockImplementation()!(id)),
      tags: ['landscape', 'night'],
    }));

    await userEvent.click(chipA());
    await userEvent.click(page.getByRole('button', { name: '#landscape' }));
    expect(host.navigate).toHaveBeenCalledWith({
      view: 'month',
      anchor: '2026-10-01',
      modelVersionId: undefined,
      tag: 'landscape',
    });

    el.location = { view: 'month', anchor: '2026-10-01', tag: 'landscape' };
    await expect
      .element(page.getByLabelText('Tag filter', { exact: true }))
      .toHaveTextContent('#landscape');
    await vi.waitFor(() =>
      expect(backend.getScheduled).toHaveBeenLastCalledWith(
        expect.objectContaining({ tag: 'landscape' })
      )
    );

    await userEvent.click(page.getByRole('button', { name: 'Clear tag filter' }));
    expect(host.navigate).toHaveBeenLastCalledWith({
      view: 'month',
      anchor: '2026-10-01',
      modelVersionId: undefined,
      tag: undefined,
    });
  });

  it('shows a still for a video cover in the calendar and the drawer strip', async () => {
    const video = post(1, POST_A, { cover: { url: 'vid-1', type: 'video' } });
    const { backend } = await mount({ view: 'month', anchor: '2026-10-01' }, [video]);
    backend.getPostDetail.mockImplementationOnce(async (id: number) => ({
      ...(await backend.getPostDetail.getMockImplementation()!(id)),
      media: [{ id: 11, url: 'vid-1', type: 'video', nsfwLevel: 1, width: 100, height: 100 }],
    }));

    const chipImg = chipA().element().querySelector('img')!;
    expect(chipImg.getAttribute('src')).toBe(
      'https://img.test/vid-1/anim=false,transcode=true,width=48/vid-1.jpeg'
    );

    await userEvent.click(chipA());
    const strip = page.getByRole('button', { name: 'Open item 1 of 1' });
    await expect.element(strip).toBeInTheDocument();
    expect(strip.element().querySelector('img')!.getAttribute('src')).toBe(
      'https://img.test/vid-1/anim=false,transcode=true,width=192/vid-1.jpeg'
    );
  });
});
