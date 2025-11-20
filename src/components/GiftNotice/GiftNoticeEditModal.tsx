import { Button, Modal } from '@mantine/core';
import * as z from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Form, InputDatePicker, InputNumber, InputText, InputTextArea, useForm } from '~/libs/form';
import type { UpsertGiftNoticeInput } from '~/server/schema/redeemableCode.schema';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  id: z.string().optional(),
  title: z.string().min(1, 'Title is required'),
  message: z.string().min(1, 'Message is required'),
  linkUrl: z
    .string()
    .min(1)
    .refine(
      (val) => val.startsWith('/') || val.startsWith('http://') || val.startsWith('https://'),
      {
        message: 'Must be a valid URL or relative path starting with /',
      }
    ),
  linkText: z.string().min(1, 'Link text is required'),
  minValue: z.number().min(0, 'Must be 0 or greater'),
  maxValue: z.number().min(0, 'Must be 0 or greater').nullable(),
  startDate: z.date(),
  endDate: z.date(),
});

export function GiftNoticeEditModal({
  notice,
}: {
  notice?: Partial<UpsertGiftNoticeInput & { id: string }>;
}) {
  const dialog = useDialogContext();
  const queryUtils = trpc.useUtils();

  const form = useForm({
    schema,
    defaultValues: {
      id: notice?.id,
      title: notice?.title || '',
      message: notice?.message || '',
      linkUrl: notice?.linkUrl || '',
      linkText: notice?.linkText || '',
      minValue: notice?.minValue ?? 0,
      maxValue: notice?.maxValue ?? null,
      startDate: notice?.startDate ? new Date(notice.startDate) : new Date(),
      endDate: notice?.endDate ? new Date(notice.endDate) : new Date(),
    },
  });

  const { mutate, isLoading } = trpc.redeemableCode.upsertGiftNotice.useMutation({
    onSuccess: () => {
      dialog.onClose();
      queryUtils.redeemableCode.getAllGiftNotices.invalidate();
    },
  });

  function handleSubmit(data: z.infer<typeof schema>) {
    mutate({
      ...data,
      id: notice?.id,
    });
  }

  return (
    <Modal {...dialog} title={`${notice?.id ? 'Edit' : 'Create'} Gift Notice`} size="lg">
      <Form form={form} onSubmit={handleSubmit} className="flex flex-col gap-3">
        <InputText name="title" label="Title" placeholder="You've received a gift!" />
        <InputTextArea
          name="message"
          label="Message"
          placeholder="Thank you for your purchase..."
          autosize
          minRows={3}
        />

        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
          <InputText name="linkText" label="CTA Text" placeholder="Learn More" />
          <InputText
            name="linkUrl"
            label="CTA URL"
            placeholder="/claim/123 or https://civitai.com/..."
            description="Relative path (e.g., /claim/123) or full URL"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
          <InputNumber
            name="minValue"
            label="Min Value (Buzz)"
            placeholder="0"
            min={0}
            description="Minimum Buzz value to show this notice"
          />
          <InputNumber
            name="maxValue"
            label="Max Value (Buzz)"
            placeholder="Leave empty for no max"
            min={0}
            description="Maximum Buzz value (leave empty for no max)"
            clearable
          />
        </div>

        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
          <InputDatePicker name="startDate" label="Start Date" />
          <InputDatePicker name="endDate" label="End Date" />
        </div>

        <Button type="submit" loading={isLoading}>
          Save Gift Notice
        </Button>
      </Form>
    </Modal>
  );
}
