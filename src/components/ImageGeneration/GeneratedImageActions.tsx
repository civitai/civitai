import { Button, Checkbox, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconDownload, IconTrash } from '@tabler/icons-react';
import { uniqBy } from 'lodash-es';
import { useRouter } from 'next/router';
import pLimit from 'p-limit';
import { useState } from 'react';
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
import { isDefined } from '~/utils/type-guards';
import { getStepMeta } from './GenerationForm/generation.utils';
import classes from './GeneratedImageActions.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';

const limit = pLimit(10);
export function GeneratedImageActions({
  actionIconSize = 'lg',
  iconSize = 20,
}: {
  actionIconSize?: MantineSpacing;
  iconSize?: number;
}) {
  const router = useRouter();
  const { images, data } = useGetTextToImageRequests();
  const { running, helpers, returnUrl } = useTourContext();
  const selectableImages = images.filter((x) => x.status === 'succeeded' && !x.blockedReason);
  const selectableImageIds = selectableImages.map((x) => x.id);
  const imageIds = images.map((x) => x.id);
  const selected = orchestratorImageSelect
    .useSelection()
    .filter((x) => imageIds.includes(x.imageId));
  const deselect = () => orchestratorImageSelect.setSelected([]);
  const [zipping, setZipping] = useState(false);

  const { updateImages, isLoading } = useUpdateImageStepMetadata({
    onSuccess: () => deselect(),
  });
  const createPostMutation = trpc.post.create.useMutation();
  // const updateWorkflows = useUpdateTextToImageWorkflows({ onSuccess: () => deselect() });

  function getSelectedImages() {
    const selectedIds = selected.map((x) => x.imageId);
    const grouped = data.flatMap((workflow) =>
      workflow.steps.flatMap((step) =>
        step.images
          .filter((x) => x.status === 'succeeded' && selectedIds.includes(x.id) && !x.blockedReason)
          .map((image, index) => ({ ...image, createdAt: workflow.createdAt, index: index + 1 }))
      )
    );
    return uniqBy(grouped, 'id');
  }

  const deleteSelectedImages = () => {
    openConfirmModal({
      title: 'Delete images',
      children: 'Are you sure that you want to delete the selected images?',
      labels: { cancel: 'Cancel', confirm: 'Yes, delete them' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        updateImages(
          selected.reduce<UpdateImageStepMetadataArgs[]>(
            (acc, { workflowId, stepName, imageId }) => {
              const index = acc.findIndex(
                (x) => x.workflowId === workflowId && x.stepName === stepName
              );
              if (index === -1)
                acc.push({ workflowId, stepName, images: { [imageId]: { hidden: true } } });
              else acc[index].images[imageId] = { hidden: true };
              return acc;
            },
            []
          )
        );
      },
      zIndex: imageGenerationDrawerZIndex + 2,
      centered: true,
    });
  };

  const isMutating = isLoading || createPostMutation.isLoading;

  const postSelectedImages = async () => {
    const selectedImages = getSelectedImages();
    // const urls = selectedImages.map((x) => x.url).filter(isDefined);
    const imageData = selectedImages
      .map((image) => {
        const workflow = data?.find((x) => x.id === image.workflowId);
        if (workflow) {
          const step = workflow.steps.find((x) => x.name === image.stepName);
          return { url: image.url, meta: getStepMeta(step) };
        }
      })
      .filter(isDefined);

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
        // updateImages({}) // tODO - show that this image has been posted?
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
    const selectedImages = getSelectedImages();
    const zip = await getJSZip();
    await Promise.all(
      selectedImages.map((image) =>
        limit(async () => {
          if (!image.url) return;
          const blob = await fetchBlob(image.url);
          if (!blob) return;
          let name = image.id;
          if (image.createdAt) {
            const dateString = image.createdAt.toISOString().replaceAll(':', '.').split('.');
            dateString.pop();
            name = `${dateString.join('.')}_${image.index}`;
            console.log({ dateString, name });
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

  const imagesCount = selectableImageIds.length;
  const selectedCount = selected.length;

  const allChecked = imagesCount > 0 && selectedCount >= imagesCount;
  const indeterminate = selectedCount > 0 && !allChecked;

  const handleCheckboxClick = (checked: boolean) => {
    if (!checked) orchestratorImageSelect.setSelected([]);
    else
      orchestratorImageSelect.setSelected(
        selectableImages.map(({ workflowId, stepName, id }) => ({
          workflowId,
          stepName,
          imageId: id,
        }))
      );
  };

  const hasSelected = !!selectedCount;

  return (
    <div className="flex items-center justify-end gap-2">
      <SortFilter type="generation" ignoreNsfwLevel />
      {!selectedCount && <MarkerFiltersDropdown />}
      {hasSelected && (
        <div className="flex gap-2">
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
