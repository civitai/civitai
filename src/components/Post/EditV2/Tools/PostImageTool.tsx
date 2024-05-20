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

export function PostImageTool({
  image,
  tool,
}: {
  image: PostEditImageDetail;
  tool: PostEditImageDetail['tools'][number];
}) {
  const debouncer = useDebouncer(1000);
  const [opened, setOpened] = useState(!!tool.notes?.length);
  const [notes, setNotes] = useState(tool.notes ?? '');
  const updateImage = usePostEditStore((state) => state.updateImage);
  const removeToolMutation = trpc.image.removeTools.useMutation({
    onSuccess: (response, { data }) => {
      for (const { imageId, toolId } of data) {
        updateImage(imageId, (image) => {
          image.tools = image.tools.filter((x) => x.id !== toolId);
        });
      }
    },
    onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
  });

  const handleRemoveTool = () => {
    if (!tool.notes) removeToolMutation.mutate({ data: [{ imageId: image.id, toolId: tool.id }] });
    // trigger confirm dialog when tool has notes
    else
      dialogStore.trigger({
        component: ConfirmDialog,
        props: {
          title: 'Remove tool',
          message: 'Are you sure you want to remove this tool?',
          labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
          confirmProps: { color: 'red', loading: removeToolMutation.isLoading },
          onConfirm: async () =>
            await removeToolMutation.mutateAsync({
              data: [{ imageId: image.id, toolId: tool.id }],
            }),
        },
      });
  };

  const updateToolMutation = trpc.image.updateTools.useMutation({
    onSuccess: (_, { data }) => {
      for (const { imageId, toolId, notes } of data) {
        updateImage(imageId, (image) => {
          const tool = image.tools.find((x) => x.id === toolId);
          if (tool) tool.notes = notes?.length ? notes : null;
        });
      }
    },
    onError: (error: any) => showErrorNotification({ error: new Error(error.message) }),
  });
  const handleUpdateTool = (notes: string) => {
    debouncer(() => {
      updateToolMutation.mutate({ data: [{ imageId: image.id, toolId: tool.id, notes }] });
    });
  };

  const dirty = notes.length && notes !== tool.notes;
  const saving = updateToolMutation.isLoading;

  return (
    <div className="flex flex-col py-1">
      <div className="flex justify-between items-center gap-3">
        <div className="flex items-center gap-1">
          <span>{tool.name}</span>
          {!tool.notes && (
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

        <ActionIcon color="red" onClick={handleRemoveTool} loading={removeToolMutation.isLoading}>
          <IconTrash size={16} />
        </ActionIcon>
      </div>
      <Collapse in={opened}>
        <Textarea
          autosize
          size="sm"
          placeholder={`How was ${getDisplayName(tool.name)} used?`}
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value.slice(0, 1000));
            handleUpdateTool(e.target.value);
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
