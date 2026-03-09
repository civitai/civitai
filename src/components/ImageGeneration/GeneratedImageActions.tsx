import { Button, Checkbox, Menu, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconDownload, IconTrash, IconWand } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import pLimit from 'p-limit';
import { useMemo, useState } from 'react';
import { SortFilter } from '~/components/Filters';
import { MarkerFiltersDropdown } from '~/components/ImageGeneration/MarkerFiltersDropdown';
import { orchestratorImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import type { UpdateImageStepMetadataArgs } from '~/components/ImageGeneration/utils/generationRequestHooks';
import {
  useGetTextToImageRequests,
  useUpdateImageStepMetadata,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';
import { fetchBlob } from '~/utils/file-utils';
import { getJSZip } from '~/utils/lazy';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { getStepMeta } from './GenerationForm/generation.utils';
import classes from './GeneratedImageActions.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import type { BlobData } from '~/shared/orchestrator/workflow-data';
import { bulkWorkflowLimits } from '~/shared/data-graph/generation/config/workflows';
import {
  useGeneratedItemWorkflows,
  applyBulkWorkflow,
} from '~/components/generation_v2/hooks/useGeneratedItemWorkflows';

const limit = pLimit(10);
export function GeneratedImageActions({
  actionIconSize = 'lg',
  iconSize = 20,
}: {
  actionIconSize?: MantineSpacing;
  iconSize?: number;
}) {
  const router = useRouter();
  const { data } = useGetTextToImageRequests();
  const { running, helpers, returnUrl } = useTourContext();
  const selectableImages = useMemo(() => data.flatMap((wf) => wf.succeededImages), [data]);
  const selected = orchestratorImageSelect.useSelection();
  const deselect = () => orchestratorImageSelect.setSelected([]);
  const [zipping, setZipping] = useState(false);

  const { updateImages, isLoading } = useUpdateImageStepMetadata({
    onSuccess: () => deselect(),
  });
  const createPostMutation = trpc.post.create.useMutation();

  const deleteSelectedImages = () => {
    openConfirmModal({
      title: 'Delete images',
      children: 'Are you sure that you want to delete the selected images?',
      labels: { cancel: 'Cancel', confirm: 'Yes, delete them' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        updateImages(
          selected.reduce<UpdateImageStepMetadataArgs[]>((acc, image) => {
            const index = acc.findIndex(
              (x) => x.workflowId === image.workflowId && x.stepName === image.stepName
            );
            if (index === -1)
              acc.push({
                workflowId: image.workflowId,
                stepName: image.stepName,
                images: { [image.id]: { hidden: true } },
              });
            else acc[index].images[image.id] = { hidden: true };
            return acc;
          }, [])
        );
      },
      zIndex: imageGenerationDrawerZIndex + 2,
      centered: true,
    });
  };

  const isMutating = isLoading || createPostMutation.isLoading;

  const postSelectedImages = async () => {
    const imageData = selected.map((image) => ({
      url: image.url,
      meta: getStepMeta(image.step),
    }));

    try {
      const key = 'generator';
      orchestratorMediaTransmitter.setUrls(key, imageData);

      if (router.pathname === '/posts/[postId]/edit') {
        await router.replace(
          { pathname: '/posts/[postId]/edit', query: { postId: router.query.postId, src: key } },
          undefined,
          { shallow: true }
        );
      } else {
        const post = await createPostMutation.mutateAsync({});
        if (running) helpers?.next();
        await router.push({
          pathname: '/posts/[postId]/edit',
          query: removeEmpty({
            postId: post.id,
            src: key,
            returnUrl: returnUrl && running ? `${returnUrl}?tour=model-page` : undefined,
          }),
        });
        generationGraphPanel.close();
      }
      deselect();
    } catch (e) {
      const error = e as Error;
      showErrorNotification({
        title: 'Failed to create post',
        error: new Error(error.message),
      });
    }
  };

  async function downloadSelected() {
    setZipping(true);
    const zip = await getJSZip();
    await Promise.all(
      selected.map((image, index) =>
        limit(async () => {
          if (!image.url) return;
          const blob = await fetchBlob(image.url);
          if (!blob) return;
          let name = image.id;
          const createdAt = image.workflow.createdAt;
          if (createdAt) {
            const dateString = createdAt.toISOString().replaceAll(':', '.').split('.');
            dateString.pop();
            name = `${dateString.join('.')}_${index + 1}`;
          }

          const file = new File([blob], name);
          const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
          zip.file(`${name}.${ext}`, file);
        })
      )
    );

    zip
      .generateAsync({ type: 'blob' })
      .then(async (blob) => {
        const createdAt = new Date().getTime();
        const blobFile = new File([blob], `images_${createdAt}.zip`, {
          type: 'application/zip',
        });

        const a = document.createElement('a');
        const href = URL.createObjectURL(blobFile);
        a.href = href;
        a.download = `images_${createdAt}.zip`;
        a.target = '_blank ';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(href);
        setZipping(false);
      })
      .catch(() => {
        setZipping(false);
      });
  }

  const imagesCount = selectableImages.length;
  const selectedCount = selected.length;

  const allChecked = imagesCount > 0 && selectedCount >= imagesCount;
  const indeterminate = selectedCount > 0 && !allChecked;

  const handleCheckboxClick = (checked: boolean) => {
    if (!checked) orchestratorImageSelect.setSelected([]);
    else orchestratorImageSelect.setSelected(selectableImages);
  };

  const hasSelected = !!selectedCount;

  return (
    <div className="flex items-center justify-end gap-2">
      <SortFilter type="generation" ignoreNsfwLevel />
      {!selectedCount && <MarkerFiltersDropdown />}
      {hasSelected && (
        <div className="flex gap-2">
          <BulkWorkflowMenu
            selected={selected}
            deselect={deselect}
            actionIconSize={actionIconSize}
            iconSize={iconSize}
          />
          <Tooltip label="Download selected">
            <LegacyActionIcon
              size={actionIconSize}
              onClick={downloadSelected}
              variant="light"
              loading={zipping}
            >
              <IconDownload size={iconSize} />
            </LegacyActionIcon>
          </Tooltip>
          <Tooltip label="Delete selected">
            <LegacyActionIcon
              size={actionIconSize}
              onClick={deleteSelectedImages}
              color="red"
              variant="light"
            >
              <IconTrash size={iconSize} />
            </LegacyActionIcon>
          </Tooltip>
          <Tooltip label="Post your generations to earn Buzz!">
            <Button
              data-tour="gen:post"
              color="blue"
              size="sm"
              h={34}
              onClick={postSelectedImages}
              loading={isMutating}
              disabled={!hasSelected}
              className={classes.buttonPost}
            >
              Post
            </Button>
          </Tooltip>
        </div>
      )}
      {selectableImages.length > 0 && (
        <Checkbox
          checked={allChecked}
          indeterminate={indeterminate}
          onChange={(e) => handleCheckboxClick(e.currentTarget.checked)}
          label={!selectedCount ? 'Select all' : `${selectedCount} selected`}
          labelPosition="left"
        />
      )}
    </div>
  );
}

// =============================================================================
// Bulk Workflow Menu
// =============================================================================

type MantineSpacing = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

function BulkWorkflowMenu({
  selected,
  deselect,
  actionIconSize,
  iconSize,
}: {
  selected: BlobData[];
  deselect: () => void;
  actionIconSize: MantineSpacing;
  iconSize: number;
}) {
  // Split selected by media type
  const selectedImages = useMemo(() => selected.filter((s) => s.type === 'image'), [selected]);
  const selectedVideos = useMemo(() => selected.filter((s) => s.type === 'video'), [selected]);

  // Get workflows for each type
  const imageWorkflows = useGeneratedItemWorkflows({ outputType: 'image', filterBy: 'input' });
  const videoWorkflows = useGeneratedItemWorkflows({ outputType: 'video', filterBy: 'input' });

  // Filter to only workflows in bulkWorkflowLimits
  const bulkImageWorkflows = useMemo(
    () =>
      imageWorkflows.groups.flatMap((g) =>
        g.workflows.filter((w) => w.graphKey in bulkWorkflowLimits)
      ),
    [imageWorkflows.groups]
  );
  const bulkVideoWorkflows = useMemo(
    () =>
      videoWorkflows.groups.flatMap((g) =>
        g.workflows.filter((w) => w.graphKey in bulkWorkflowLimits)
      ),
    [videoWorkflows.groups]
  );

  const hasImageWorkflows = selectedImages.length > 0 && bulkImageWorkflows.length > 0;
  const hasVideoWorkflows = selectedVideos.length > 0 && bulkVideoWorkflows.length > 0;

  if (!hasImageWorkflows && !hasVideoWorkflows) return null;

  const showCategories = hasImageWorkflows && hasVideoWorkflows;

  return (
    <Menu zIndex={imageGenerationDrawerZIndex + 2} withinPortal position="bottom-start">
      <Menu.Target>
        <Tooltip label="Apply workflow to selected">
          <LegacyActionIcon size={actionIconSize} variant="light" color="violet">
            <IconWand size={iconSize} />
          </LegacyActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        {hasImageWorkflows && (
          <>
            {showCategories && <Menu.Label>Image</Menu.Label>}
            {bulkImageWorkflows.map((w) => {
              const max = bulkWorkflowLimits[w.graphKey];
              const count = selectedImages.length;
              const label =
                count > max ? `${w.label} (${max} of ${count} images)` : `${w.label} (${count})`;
              return (
                <Menu.Item
                  key={w.id}
                  onClick={() => {
                    applyBulkWorkflow(w.graphKey, selectedImages);
                    deselect();
                  }}
                >
                  {label}
                </Menu.Item>
              );
            })}
          </>
        )}
        {hasVideoWorkflows && (
          <>
            {showCategories && <Menu.Label>Video</Menu.Label>}
            {bulkVideoWorkflows.map((w) => {
              const max = bulkWorkflowLimits[w.graphKey];
              const count = selectedVideos.length;
              const label =
                count > max ? `${w.label} (${max} of ${count} videos)` : `${w.label} (${count})`;
              return (
                <Menu.Item
                  key={w.id}
                  onClick={() => {
                    applyBulkWorkflow(w.graphKey, selectedVideos);
                    deselect();
                  }}
                >
                  {label}
                </Menu.Item>
              );
            })}
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
