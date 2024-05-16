import { ActionIcon, Text, Collapse, Textarea } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { IconMessagePlus } from '@tabler/icons-react';
import { useState } from 'react';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { PostEditImageDetail, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { useDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function PostImageTechnique({
  image,
  technique,
}: {
  image: PostEditImageDetail;
  technique: PostEditImageDetail['techniques'][number];
}) {
  const debouncer = useDebouncer(1000);
  const [opened, setOpened] = useState(!!technique.notes?.length);
  const [notes, setNotes] = useState(technique.notes ?? '');
  const updateImage = usePostEditStore((state) => state.updateImage);
  const removeTechniqueMutation = trpc.image.removeTechniques.useMutation({
    onSuccess: (response, { data }) => {
      for (const { imageId, techniqueId } of data) {
        updateImage(imageId, (image) => {
          image.techniques = image.techniques.filter((x) => x.id !== techniqueId);
        });
      }
    },
    onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
  });

  const handleRemoveTechnique = () => {
    if (!technique.notes)
      removeTechniqueMutation.mutate({ data: [{ imageId: image.id, techniqueId: technique.id }] });
    // trigger confirm dialog when technique has notes
    else
      dialogStore.trigger({
        component: ConfirmDialog,
        props: {
          title: 'Remove technique',
          message: 'Are you sure you want to remove this technique?',
          labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
          confirmProps: { color: 'red', loading: removeTechniqueMutation.isLoading },
          onConfirm: async () =>
            await removeTechniqueMutation.mutateAsync({
              data: [{ imageId: image.id, techniqueId: technique.id }],
            }),
        },
      });
  };

  const updateTechniqueMutation = trpc.image.updateTechniques.useMutation({
    onSuccess: (_, { data }) => {
      for (const { imageId, techniqueId, notes } of data) {
        updateImage(imageId, (image) => {
          const technique = image.techniques.find((x) => x.id === techniqueId);
          if (technique) technique.notes = notes?.length ? notes : null;
        });
      }
    },
    onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
  });
  const handleUpdateTechnique = (notes: string) => {
    debouncer(() => {
      updateTechniqueMutation.mutate({
        data: [{ imageId: image.id, techniqueId: technique.id, notes }],
      });
    });
  };

  const dirty = notes.length && notes !== technique.notes;
  const saving = updateTechniqueMutation.isLoading;

  return (
    <div className="flex flex-col py-1">
      <div className="flex justify-between items-center gap-3">
        <div className="flex items-center gap-1">
          <span>{technique.name}</span>
          {!technique.notes && (
            <Text
              inline
              color="blue"
              className="cursor-pointer"
              onClick={() => setOpened((o) => !o)}
            >
              <IconMessagePlus size={16} />
            </Text>
          )}
        </div>

        <ActionIcon
          color="red"
          onClick={handleRemoveTechnique}
          loading={removeTechniqueMutation.isLoading}
        >
          <IconTrash size={16} />
        </ActionIcon>
      </div>
      <Collapse in={opened}>
        <Textarea
          autosize
          size="sm"
          placeholder={`How was ${technique.name} used?`}
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value.slice(0, 1000));
            handleUpdateTechnique(e.target.value);
          }}
          classNames={{
            input: `px-2 py-1 min-h-8 mb-2 ${
              saving
                ? '!border-green-6 dark:!border-green-8'
                : dirty
                ? '!border-yellow-6 dark:!border-yellow-8'
                : ''
            }`,
          }}
        />
      </Collapse>
    </div>
  );
}
