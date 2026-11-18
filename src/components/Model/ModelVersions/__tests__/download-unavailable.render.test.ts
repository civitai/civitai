import { createElement } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as MantineOverlays from '~/components/MantineOverlays';

// JoinPopover shows its prompt only after a click, which static markup cannot do; the marker
// records whether the button was wrapped in it, and with what message.
vi.mock('~/components/JoinPopover/JoinPopover', () => ({
  JoinPopover: ({ children, message }: { children: ReactNode; message?: string }) =>
    createElement('div', { 'data-join-popover': message ?? '' }, children),
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => ({}),
}));

// A closed tooltip renders nothing to static markup; the marker exposes the label it would show.
vi.mock('~/components/MantineOverlays', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineOverlays>()),
  Tooltip: ({ children, label }: { children: ReactNode; label?: ReactNode }) =>
    createElement('div', { 'data-tooltip': typeof label === 'string' ? label : '' }, children),
}));

const { DownloadVariantDropdown } = await import(
  '~/components/Model/ModelVersions/DownloadVariantDropdown'
);

const file = {
  id: 11,
  name: 'model.safetensors',
  sizeKB: 2048,
  type: 'Model',
  visibility: 'Public',
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
  hashes: [],
} as never;

const secondFile = {
  ...(file as object),
  id: 12,
  name: 'model-fp8.safetensors',
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp8' },
} as never;

type Props = Parameters<typeof DownloadVariantDropdown>[0];

function render(props: Partial<Props>) {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(DownloadVariantDropdown, {
        files: [file],
        versionId: 7,
        modelType: 'Checkpoint',
        canDownload: false,
        onPurchase: () => undefined,
        ...props,
      } as Props)
    )
  );
}

describe('download button on a non-commercially locked version', () => {
  it('shows no membership prompt and says the version is not available for download', () => {
    const html = render({ notCommerciallyLocked: true });
    expect(html).not.toContain('data-join-popover');
    expect(html).toContain('Not available for download');
    expect(html).toContain('data-tooltip="Not commercially available at the moment"');
    expect(html).toMatch(/<a[^>]*data-disabled="true"[^>]*>/);
  });

  it('shows the same state on the multi-file "Download Selected" button', () => {
    const html = render({ files: [file, secondFile], notCommerciallyLocked: true });
    expect(html).not.toContain('data-join-popover');
    expect(html).not.toContain('Download Selected');
    expect(html).toContain('data-tooltip="Not commercially available at the moment"');
  });

  it('keeps the membership prompt for a locked version that is not non-commercial', () => {
    const html = render({ notCommerciallyLocked: false });
    expect(html).toContain('data-join-popover="You need to be a member to start the download"');
    expect(html).not.toContain('Not available for download');
  });

  it('leaves a paid version on its purchase path: price shown, no prompt, no download link', () => {
    const html = render({ downloadPrice: 500, notCommerciallyLocked: false });
    expect(html).not.toContain('data-join-popover');
    expect(html).not.toContain('Not available for download');
    expect(html).toContain('500');
    expect(html).not.toMatch(/href="[^"]*\/api\/download/);
  });

  it('leaves a downloadable version as a plain download link', () => {
    const html = render({ canDownload: true });
    expect(html).not.toContain('data-join-popover');
    expect(html).not.toContain('Not available for download');
    expect(html).toMatch(/href="[^"]*\/api\/download\/models\/7/);
  });
});
