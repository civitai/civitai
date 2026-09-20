// @vitest-environment happy-dom
import { randomUUID } from 'crypto';
import { expect, it } from 'vitest';

// A node builtin imported from a test the WEB transform handles resolves to
// `__vite-browser-external:crypto` — a module id no path can name. Fingerprinting it as a file
// said "missing", which the reporter read as a module deleted mid-run, and all 44 happy-dom tests
// in the repo went unrecorded. Whoever deletes this: the point is the id, not the UUID.
it('passes', () => {
  expect(typeof randomUUID).toBe('function');
});
