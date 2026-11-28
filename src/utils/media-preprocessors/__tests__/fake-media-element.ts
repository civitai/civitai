import { vi } from 'vitest';

type Behavior = 'load' | 'error' | 'never';

/**
 * Makes `document.createElement('audio' | 'video')` return a stand-in: happy-dom never decodes
 * media, so loadedmetadata/error/durationchange are fired by hand. Seeking to the end gives a
 * duration-less file (`Infinity`) its real `resolvedDuration`, as a browser does for a WebM.
 */
export function mockMediaElements(
  behavior: Behavior,
  {
    duration = 12.3456,
    resolvedDuration,
    videoWidth = 16,
  }: { duration?: number; resolvedDuration?: number; videoWidth?: number } = {}
) {
  const created: (EventTarget & Record<string, unknown>)[] = [];
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'audio' && tag !== 'video') return create(tag);
    const el = new EventTarget() as EventTarget & Record<string, unknown>;
    el.duration = duration;
    el.videoWidth = videoWidth;
    el.videoHeight = 16;
    el.removeAttribute = vi.fn();
    el.load = vi.fn();
    created.push(el);
    Object.defineProperty(el, 'src', {
      set() {
        if (behavior === 'never') return;
        queueMicrotask(() =>
          el.dispatchEvent(new Event(behavior === 'load' ? 'loadedmetadata' : 'error'))
        );
      },
    });
    Object.defineProperty(el, 'currentTime', {
      set() {
        if (resolvedDuration === undefined) return;
        el.duration = resolvedDuration;
        queueMicrotask(() => el.dispatchEvent(new Event('durationchange')));
      },
    });
    return el;
  }) as unknown as typeof document.createElement);
  return created;
}
