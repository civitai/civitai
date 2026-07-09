/**
 * Full-screen, view-only viewer for a generated PolyGen 3D model.
 *
 * Single-item modal (no carousel): mirrors the image lightbox's full-screen
 * Modal chrome but renders the variant-aware three.js viewer for inspection
 * only — Post/Download stay on the queue card. Opened from
 * `Model3DQueueCardOutputs` via the local `dialogStore` (id `generated-model3d`),
 * the same non-routed pattern the image lightbox uses.
 */

import { Modal, Text } from '@mantine/core';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { getModel3DViewableVariants } from '~/components/Model3D/Viewer/Model3DOutputActions';
import type { Model3DBlob } from '~/shared/orchestrator/workflow-data';

const Model3DVariantViewerDynamic = dynamic(
  () =>
    import('~/components/Model3D/Viewer/Model3DVariantViewer').then((m) => m.Model3DVariantViewer),
  { ssr: false }
);

export default function Model3DLightbox({ blob }: { blob: Model3DBlob }) {
  const dialog = useDialogContext();
  const variants = useMemo(() => getModel3DViewableVariants(blob), [blob]);

  return (
    <Modal
      {...dialog}
      closeButtonProps={{ 'aria-label': 'Close 3D viewer' }}
      fullScreen
      withOverlay={false}
      withinPortal={!dialog.target}
      zIndex={dialog.target ? undefined : 400}
      styles={{
        inner: { position: 'absolute' },
        content: { display: 'flex', flexDirection: 'column', overflow: 'hidden' },
        header: { position: 'absolute', right: 0, zIndex: 10 },
        body: { flex: 1, minHeight: 0, overflow: 'hidden', padding: 16 },
      }}
    >
      <div className="relative size-full overflow-hidden">
        {variants.length ? (
          <Model3DVariantViewerDynamic
            variants={variants}
            compact
            className="size-full"
            comboboxZIndex={500}
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Text c="dimmed" size="sm">
              No previewable 3D file available.
            </Text>
          </div>
        )}
      </div>
    </Modal>
  );
}
