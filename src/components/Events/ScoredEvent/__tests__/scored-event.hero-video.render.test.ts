// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import type * as MantineCore from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EventsUtils from '~/components/Events/events.utils';

/**
 * The event film on the hero: a play button on the art that names the film and its length, and a
 * player that opens with sound and offers Join to a viewer who has not joined yet.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { trigger, onClose } = vi.hoisted(() => ({ trigger: vi.fn(), onClose: vi.fn() }));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger } }));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose }),
}));
vi.mock('@mantine/core', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineCore>()),
  // Rendered inline so the player lands in the test's host rather than a portal.
  Modal: ({ title, children }: { title: React.ReactNode; children: React.ReactNode }) =>
    React.createElement('div', null, title, children),
}));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => () => 'pink',
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({ EdgeMedia: () => null }));
// The real player needs a scroller and media APIs; this one records what it was told.
vi.mock('~/components/EdgeMedia/EdgeVideo', () => ({
  EdgeVideo: (props: Record<string, unknown>) =>
    React.createElement('video', {
      'data-src': props.src,
      'data-options': JSON.stringify(props.options),
      'data-autoplay': String(props.autoPlay),
      'data-muted': String(props.muted),
      'data-controls': String(props.controls),
      'data-html5-controls': String(props.html5Controls),
      'data-hover-play': String(props.hoverPlay),
    }),
}));
vi.mock('~/components/Countdown/Countdown', () => ({ Countdown: () => null }));
// Marks what it wraps, so a test can see that an action asks a signed-out viewer to sign in.
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', { 'data-login-redirect': '' }, children),
}));

const { ScoredEventHero } = await import('~/components/Events/ScoredEvent/ScoredEventHero');
const { HERO_VIDEO_OPTIONS } = await import('~/components/Events/ScoredEvent/scored-event.utils');
const { default: EventVideoModal } = await import(
  '~/components/Events/ScoredEvent/EventVideoModal'
);

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
  trigger.mockReset();
  onClose.mockReset();
});

function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(MantineProvider, null, element)));
  return host;
}

const VIDEO = { id: '2a717391-711f-4005-97df-16921dc25e07', title: 'Hats On' };
type HeroProps = React.ComponentProps<typeof ScoredEventHero>;
const hero = (over: Partial<HeroProps> = {}, page: Record<string, unknown> = {}) =>
  render(
    React.createElement(ScoredEventHero, {
      data: {
        title: 'Birthday',
        teams: ['Yellow', 'Blue', 'Pink', 'Green'],
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        endDate: new Date('2026-12-01T00:00:00.000Z'),
        page: { headline: 'Hats', heroImage: 'art', heroVideo: VIDEO, ...page },
      } as unknown as HeroProps['data'],
      ended: false,
      onJoin: vi.fn(),
      joining: false,
      ...over,
    })
  );
const watchButton = (page: HTMLElement) =>
  page.querySelector<HTMLButtonElement>('button[aria-label="Watch the Hats On video"]');

describe('hero play button', () => {
  it('sits on the art, named for the film', () => {
    const page = hero();
    const button = watchButton(page);
    expect(button?.closest('[data-testid=hero-art]')).not.toBeNull();
    expect(button?.textContent).toBe('Watch');
  });

  it('is absent without a film', () => {
    const page = hero({}, { heroVideo: undefined });
    expect(watchButton(page)).toBeNull();
  });

  // The detached element the hero reads the film's length from.
  const probeVideo = () => {
    const create = document.createElement.bind(document);
    const probe: { video?: HTMLVideoElement } = {};
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = create(tag);
      if (tag === 'video') probe.video = el as HTMLVideoElement;
      return el;
    }) as typeof document.createElement);
    return probe;
  };
  const readMetadata = (video: HTMLVideoElement, duration: number) => {
    Object.defineProperty(video, 'duration', { value: duration });
    act(() => {
      video.dispatchEvent(new Event('loadedmetadata'));
    });
  };

  it("adds the film's length once its metadata reads, to the nearest second", () => {
    const probe = probeVideo();
    const page = hero();
    expect(probe.video?.preload).toBe('metadata');
    expect(probe.video?.getAttribute('src')).toContain(VIDEO.id);
    readMetadata(probe.video!, 84.6);
    expect(watchButton(page)?.textContent).toBe('Watch · 1:25');
  });

  it.each([Infinity, 0])('keeps plain Watch for a length of %s', (duration) => {
    const probe = probeVideo();
    const page = hero();
    readMetadata(probe.video!, duration);
    expect(watchButton(page)?.textContent).toBe('Watch');
  });

  it('stops reading the film when the hero goes', () => {
    const probe = probeVideo();
    hero();
    expect(probe.video?.hasAttribute('src')).toBe(true);
    act(() => root?.unmount());
    expect(probe.video?.hasAttribute('src')).toBe(false);
  });

  it('opens the player with Join for a viewer who has not joined', () => {
    const onJoin = vi.fn();
    const page = hero({ onJoin });
    act(() => watchButton(page)!.click());
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0]).toEqual({
      component: EventVideoModal,
      props: { video: VIDEO, onJoin },
    });
  });

  it.each([
    ['joined', { team: 'Pink' }],
    ['ended', { ended: true }],
  ])('opens the player without Join once %s', (_, over) => {
    const page = hero(over);
    act(() => watchButton(page)!.click());
    expect(trigger.mock.calls[0][0].props).toEqual({ video: VIDEO, onJoin: undefined });
  });
});

describe('EventVideoModal', () => {
  const modal = (onJoin?: () => unknown) =>
    render(React.createElement(EventVideoModal, { video: VIDEO, onJoin }));
  const joinButton = (page: HTMLElement) =>
    [...page.querySelectorAll('button')].find(
      (b) => b.textContent === 'Join and get your free hat'
    );

  it('plays the film the hero measured, with sound and the browser controls', () => {
    const video = modal().querySelector('video');
    expect({ ...video?.dataset }).toEqual({
      src: VIDEO.id,
      options: JSON.stringify(HERO_VIDEO_OPTIONS),
      autoplay: 'true',
      muted: 'false',
      controls: 'true',
      html5Controls: 'true',
      hoverPlay: 'false',
    });
  });

  it('offers Join behind sign-in, and closes once joined', async () => {
    let finish!: () => void;
    const onJoin = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const page = modal(onJoin);
    const button = joinButton(page)!;
    expect(button.closest('[data-login-redirect]')).not.toBeNull();
    act(() => button.click());
    expect(onJoin).toHaveBeenCalledTimes(1);
    // Still joining: the player stays open and the button shows it is working.
    expect(onClose).not.toHaveBeenCalled();
    expect(button.hasAttribute('data-loading')).toBe(true);
    await act(async () => finish());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute('data-loading')).toBe(false);
  });

  it('has no Join without a handler', () => {
    expect(joinButton(modal())).toBeUndefined();
  });
});
