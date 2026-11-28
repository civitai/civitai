import { afterEach } from 'vitest';

/**
 * The src of every `<img>` whose load failed, cleared after each test. Nothing serves an image in the
 * test browser (and `getEdgeUrl` rewrites even a `data:` URI), so a rendered cover fails to load a
 * moment after it mounts and a load-error fallback then removes it: its failure is the trace that
 * it rendered. Call once at module scope.
 */
export function recordImageLoadErrors() {
  const srcs: string[] = [];
  document.addEventListener(
    'error',
    (e) => {
      if (e.target instanceof HTMLImageElement) srcs.push(e.target.src);
    },
    true
  );
  afterEach(() => {
    srcs.length = 0;
  });
  return srcs;
}
