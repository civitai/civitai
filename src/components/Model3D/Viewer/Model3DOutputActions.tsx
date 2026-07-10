/**
 * Shared "Post" + "Download" actions for a generated PolyGen 3D model, plus
 * a helper to derive the in-browser-viewable variant list from a blob.
 *
 * Used by both the generator queue card (`Model3DQueueCardOutputs` in
 * QueueItem.tsx) and the full-screen `Model3DLightbox` so the two share one
 * implementation of the Post/Download flow rather than duplicating it.
 */

import { Button, Menu } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { useRouter } from 'next/router';

import type { Model3DViewableVariant } from '~/components/Model3D/Viewer/Model3DVariantViewer';
import type { Model3DAsset, Model3DBlob } from '~/shared/orchestrator/workflow-data';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * GLB-only viewable variants the inline three.js viewer can mount. FBX isn't
 * supported by GLTFLoader and armature-only files render empty, so both are
 * filtered out. Mirrors the taxonomy used server-side by `Model3DFile.variant`.
 */
export function getModel3DViewableVariants(blob: Model3DBlob): Model3DViewableVariant[] {
  const isViewable = (fmt: string) => fmt.toLowerCase() === 'glb';
  const list: Model3DViewableVariant[] = [];
  if (blob.url && isViewable(blob.format))
    list.push({ key: 'base', label: 'Base', url: blob.url, format: blob.format });
  const pushAsset = (key: string, label: string, asset: Model3DAsset | undefined) => {
    if (asset?.url && isViewable(asset.format))
      list.push({ key, label, url: asset.url, format: asset.format });
  };
  pushAsset('rigged', 'Rigged', blob.rigged);
  pushAsset('animated', 'Animated', blob.animated);
  pushAsset('walking', 'Walking', blob.basicAnimations?.walking);
  pushAsset('running', 'Running', blob.basicAnimations?.running);
  return list;
}

type DownloadEntry = { label: string; format: string; url: string };

/** Flatten every downloadable file (base + sibling meshes, each format) into rows. */
function getDownloadEntries(blob: Model3DBlob): DownloadEntry[] {
  const entries: DownloadEntry[] = [];
  const pushAsset = (label: string, asset: Model3DAsset | undefined) => {
    if (!asset?.url) return;
    entries.push({ label, format: asset.format, url: asset.url });
    if (asset.fbx?.url) entries.push({ label, format: asset.fbx.format, url: asset.fbx.url });
    if (asset.armature?.url)
      entries.push({
        label: `${label} (armature)`,
        format: asset.armature.format,
        url: asset.armature.url,
      });
  };

  // Base mesh: primary GLB + its alternate-format siblings on `variants[]`.
  if (blob.url) entries.push({ label: 'Base', format: blob.format, url: blob.url });
  for (const v of blob.variants ?? []) {
    if (v?.url) entries.push({ label: 'Base', format: v.format, url: v.url });
  }

  pushAsset('Rigged', blob.rigged);
  pushAsset('Animated', blob.animated);
  pushAsset('Walking', blob.basicAnimations?.walking);
  pushAsset('Running', blob.basicAnimations?.running);
  return entries;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

export function Model3DOutputActions({
  blob,
  workflowId,
  isComplete,
  buttonSize = 'compact-sm',
}: {
  blob: Model3DBlob | null | undefined;
  workflowId: string;
  isComplete: boolean;
  buttonSize?: string;
}) {
  const router = useRouter();

  // Idempotent on workflowId: copies the orchestrator blobs to our S3, ingests
  // the thumbnail through the standard image pipeline, and writes the Draft +
  // Model3DFile rows, then lands the owner on the edit page to name + publish.
  const ensureModel3D = trpc.model3d.ensureFromWorkflow.useMutation({
    onError: (error) => {
      showErrorNotification({
        title: 'Could not save your 3D model',
        error: new Error(error.message),
      });
    },
  });

  const handleSaveToLibrary = async () => {
    try {
      const draft = await ensureModel3D.mutateAsync({ workflowId });
      await router.push(`/3d-models/${draft.id}/edit`);
    } catch {
      // notification already fired via mutation onError
    }
  };

  const entries = isComplete && blob ? getDownloadEntries(blob) : [];

  const filename = (e: DownloadEntry) =>
    e.label === 'Base'
      ? `civitai-3d-${workflowId}.${e.format}`
      : `civitai-3d-${workflowId}.${slug(e.label)}.${e.format}`;

  return (
    <div className="flex gap-2">
      <Button
        onClick={handleSaveToLibrary}
        variant="light"
        size={buttonSize}
        fullWidth
        loading={ensureModel3D.isPending}
        disabled={!isComplete || ensureModel3D.isPending}
      >
        Post
      </Button>

      {/* Presigned URLs are short-lived — "download now or never", same as Post. */}
      {entries.length === 0 ? (
        <Button
          variant="light"
          size={buttonSize}
          fullWidth
          disabled
          leftSection={<IconDownload size={14} stroke={2} />}
        >
          Download
        </Button>
      ) : entries.length === 1 ? (
        <Button
          component="a"
          href={entries[0].url}
          download={filename(entries[0])}
          target="_blank"
          rel="noopener noreferrer"
          variant="light"
          size={buttonSize}
          fullWidth
          leftSection={<IconDownload size={14} stroke={2} />}
        >
          Download
        </Button>
      ) : (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Button
              variant="light"
              size={buttonSize}
              fullWidth
              leftSection={<IconDownload size={14} stroke={2} />}
            >
              Download
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {entries.map((e, i) => (
              <Menu.Item
                key={`${e.label}-${e.format}-${i}`}
                component="a"
                href={e.url}
                download={filename(e)}
                target="_blank"
                rel="noopener noreferrer"
                leftSection={<IconDownload size={14} stroke={2} />}
              >
                {e.label === 'Base'
                  ? e.format.toUpperCase()
                  : `${e.label} · ${e.format.toUpperCase()}`}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
    </div>
  );
}
