import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';

const SRC = '00000001-0000-4000-8000-000000000000';

const hoverFor = (ms: number) => {
  const video = document.querySelector('video')!;
  video.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  vi.advanceTimersByTime(ms);
};

let play: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  play.mockRestore();
});

describe('EdgeVideo — hover to play', () => {
  test('plays after a second of hover by default', async () => {
    renderWithProviders(<EdgeVideo src={SRC} />);
    await vi.waitFor(() => expect(document.querySelector('video')).toBeTruthy());

    hoverFor(1_100);

    expect(play).toHaveBeenCalled();
  });

  test('never plays on hover with hoverPlay off', async () => {
    renderWithProviders(<EdgeVideo src={SRC} hoverPlay={false} />);
    await vi.waitFor(() => expect(document.querySelector('video')).toBeTruthy());

    hoverFor(1_100);

    expect(play).not.toHaveBeenCalled();
  });
});

describe('EdgeVideo — only the frontmost layer plays', () => {
  afterEach(() => useDialogStore.getState().closeAll());

  test('a video that mounts under an open dialog stays paused', async () => {
    // The remix card remounts the page behind the detail dialog; that new player is born at
    // depth 1 and used to read itself as the frontmost layer.
    dialogStore.trigger({ id: 'imageDetail_1', component: () => null, type: 'routed-dialog' });

    renderWithProviders(<EdgeVideo src={SRC} autoPlay />);
    await vi.waitFor(() => expect(document.querySelector('video')).toBeTruthy());

    expect(play).not.toHaveBeenCalled();
  });

  test('a video inside the top dialog plays', async () => {
    function Detail() {
      return <EdgeVideo src={SRC} autoPlay />;
    }
    renderWithProviders(<DialogProvider />);
    dialogStore.trigger({ id: 'imageDetail_1', component: Detail, type: 'routed-dialog' });
    await vi.waitFor(() => expect(play).toHaveBeenCalled());
  });

  test('a video in a dialog pauses once another dialog opens over it', async () => {
    function Detail() {
      return <EdgeVideo src={SRC} autoPlay />;
    }
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    renderWithProviders(<DialogProvider />);
    dialogStore.trigger({ id: 'imageDetail_1', component: Detail, type: 'routed-dialog' });
    await vi.waitFor(() => expect(play).toHaveBeenCalled());

    dialogStore.trigger({ id: 'imageDetail_2', component: () => null, type: 'routed-dialog' });
    await vi.waitFor(() => expect(pause).toHaveBeenCalled());
    pause.mockRestore();
  });

  test('a video in a dialog plays again once the dialog over it closes', async () => {
    function Detail() {
      return <EdgeVideo src={SRC} autoPlay />;
    }
    renderWithProviders(<DialogProvider />);
    dialogStore.trigger({ id: 'imageDetail_1', component: Detail, type: 'routed-dialog' });
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    dialogStore.trigger({ id: 'imageDetail_2', component: () => null, type: 'routed-dialog' });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(2));

    dialogStore.closeById('imageDetail_2');

    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  });

  test('a player on the page plays while no dialog is open, and again after one closes', async () => {
    renderWithProviders(<EdgeVideo src={SRC} autoPlay />);
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    dialogStore.trigger({ id: 'imageDetail_1', component: () => null, type: 'routed-dialog' });
    dialogStore.closeById('imageDetail_1');

    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  });
});
