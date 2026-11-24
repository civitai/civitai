import { afterEach, describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { FeaturePageFrame } from '~/components/FeaturePages/FeaturePageHost';

// A frame that never says fp-ready: the case where its fp-ready was posted before the host's
// listener existed (a server-rendered iframe loads before hydration).
const SILENT_FRAME = `<!doctype html><script>
  window.received = [];
  addEventListener('message', (e) => window.received.push(e.data.type));
</script>`;

const deps = {
  feature: 'urn:test',
  theme: 'dark' as const,
  signedIn: false,
  openLogin: vi.fn(),
  maskProfanity: false,
  discussion: false,
  vote: vi.fn(),
  mine: vi.fn(),
  comment: vi.fn(),
  editComment: vi.fn(),
  retractComment: vi.fn(),
  reportComment: vi.fn(),
  navigate: vi.fn(),
};

let frameUrl: string | undefined;
afterEach(() => {
  if (frameUrl) URL.revokeObjectURL(frameUrl);
});

describe('FeaturePageFrame', () => {
  test('sends fp-init to a frame that never asks for it', async () => {
    frameUrl = URL.createObjectURL(new Blob([SILENT_FRAME], { type: 'text/html' }));
    await renderWithProviders(
      <FeaturePageFrame src={frameUrl} origin={location.origin} deps={deps} />
    );
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;

    await vi.waitFor(() => {
      const received = (iframe.contentWindow as Window & { received?: string[] }).received;
      expect(received).toContain('fp-init');
    });
  });
});
