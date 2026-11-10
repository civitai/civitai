export const MEDIA_PROBE_TIMEOUT_MS = 15_000;

function once(el: HTMLMediaElement, ok: string, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      el.removeEventListener(ok, onOk);
      el.removeEventListener('error', onError);
      resolve(value);
    };
    const onOk = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onError);
  });
}

/**
 * A MediaRecorder WebM has no duration in its header, so the element reports `Infinity` until it
 * has seeked to the end. `undefined` when that does not resolve it either.
 */
async function resolveDuration(el: HTMLMediaElement): Promise<number | undefined> {
  if (Number.isFinite(el.duration)) return el.duration;
  const changed = once(el, 'durationchange', MEDIA_PROBE_TIMEOUT_MS);
  el.currentTime = Number.MAX_SAFE_INTEGER;
  await changed;
  return Number.isFinite(el.duration) ? el.duration : undefined;
}

export function releaseMediaElement(el: HTMLMediaElement) {
  el.removeAttribute('src');
  el.load();
}

/**
 * Loads `src` into a muted media element and reads its duration in seconds. `null` when the
 * browser cannot decode it or the metadata does not arrive in time. The caller owns the error
 * copy, the object URL and, on success, releasing the element with `releaseMediaElement`.
 */
export async function probeMediaElement(
  kind: 'video' | 'audio',
  src: string
): Promise<{ element: HTMLMediaElement; duration: number | undefined } | null> {
  const element = document.createElement(kind);
  element.preload = 'metadata';
  element.muted = true;
  const loaded = once(element, 'loadedmetadata', MEDIA_PROBE_TIMEOUT_MS);
  element.src = src;
  if (!(await loaded)) {
    releaseMediaElement(element);
    return null;
  }
  return { element, duration: await resolveDuration(element) };
}
