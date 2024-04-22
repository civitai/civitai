import { Button, Modal, Text } from '@mantine/core';
import { useState } from 'react';
import { z } from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Form, InputNumber, InputSelect, InputTextArea, useForm } from '~/libs/form';
import { constants } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { baseImageMetaSchema } from '~/server/schema/image.schema';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { auditImageMeta } from '~/utils/media-preprocessors';
import { trpc } from '~/utils/trpc';

export function ImageMetaModal({
  id,
  meta,
  nsfwLevel = NsfwLevel.PG,
  updateImage,
  ...props
}: {
  id: number;
  meta?: z.infer<typeof baseImageMetaSchema>;
  blockedFor?: string;
  nsfwLevel?: number;
  updateImage: (
    id: number,
    cb: (props: { meta?: z.infer<typeof baseImageMetaSchema> | null }) => void
  ) => void;
}) {
  const dialog = useDialogContext();
  const [blockedFor, setBlockedFor] = useState(props.blockedFor);

  const { mutate, isLoading } = trpc.post.updateImage.useMutation();
  const form = useForm({ schema: baseImageMetaSchema, defaultValues: meta });

  const handleSubmit = async (data: z.infer<typeof baseImageMetaSchema>) => {
    const { blockedFor } = await auditImageMeta(data, !getIsSafeBrowsingLevel(nsfwLevel));
    setBlockedFor(blockedFor?.join(', '));
    if (!blockedFor)
      mutate(
        { id, meta: { ...meta, ...data } },
        {
          onSuccess: () => {
            updateImage(id, (image) => {
              image.meta = { ...image.meta, ...data };
            });
            dialog.onClose();
          },
        }
      );
  };

  return (
    <Modal {...dialog} title={<Text className="font-semibold">Image details</Text>} centered>
      <Form form={form} onSubmit={handleSubmit}>
        <div className="flex flex-col gap-3">
          <InputTextArea
            name="prompt"
            label="Prompt"
            autosize
            error={!!blockedFor?.length ? `blocked for: ${blockedFor}` : undefined}
          />
          <InputTextArea name="negativePrompt" label="Negative prompt" autosize />
          <div className="grid grid-cols-2 gap-3">
            <InputNumber name="cfgScale" label="Guidance scale" min={0} max={30} />
            <InputNumber name="steps" label="Steps" />
          </div>
          <InputSelect
            name="sampler"
            clearable
            searchable
            data={constants.samplers as unknown as string[]}
            label="Sampler"
          />
          <InputNumber name="seed" label="Seed" format="default" />
        </div>
        <div className="flex justify-end mt-4">
          <Button type="submit" loading={isLoading}>
            Save
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
