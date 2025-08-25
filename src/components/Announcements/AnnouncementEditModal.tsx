import type { SelectProps } from '@mantine/core';
import { Button, ColorSwatch, Modal, useMantineTheme } from '@mantine/core';
import dayjs from '~/shared/utils/dayjs';
import { useRef } from 'react';
import * as z from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  Form,
  InputCheckbox,
  InputDatePicker,
  InputSelect,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import type { UpsertAnnouncementSchema } from '~/server/schema/announcement.schema';
import { dateWithoutTimezone, endOfDay, startOfDay } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  title: z.string(),
  content: z.string(),
  color: z.string(),
  startsAt: z.date(),
  endsAt: z.date().nullish(),
  image: z.string().optional(),
  disabled: z.boolean().optional(),
  linkText: z.string().optional(),
  linkUrl: z.string().optional(),
});

export function AnnouncementEditModal({
  announcement,
}: {
  announcement?: Partial<UpsertAnnouncementSchema>;
}) {
  const dialog = useDialogContext();

  // const startsAt = announcement?.startsAt ?? new Date();
  // const date = new Date(startsAt);
  // if (!announcement?.endsAt) date.setDate(startsAt.getDate() + 1);
  const endsAt = announcement?.endsAt;
  const action = announcement?.metadata?.actions?.[0];
  const queryUtils = trpc.useUtils();
  const startsAtRef = useRef<Date | null>(null);
  const isToday = announcement?.startsAt?.toDateString() === new Date().toDateString();

  const form = useForm({
    schema,
    defaultValues: {
      ...announcement,
      startsAt: announcement?.startsAt
        ? isToday
          ? announcement.startsAt
          : startOfDay(dateWithoutTimezone(announcement.startsAt))
        : new Date(),
      endsAt: endsAt ? startOfDay(dateWithoutTimezone(endsAt)) : null,
      image: announcement?.metadata?.image,
      linkText: action?.linkText,
      linkUrl: action?.link,
    },
  });
  const theme = useMantineTheme();
  const colors = Object.keys(theme.colors);

  const { mutate, isLoading } = trpc.announcement.upsertAnnouncement.useMutation({
    onSuccess: () => {
      dialog.onClose();
      queryUtils.announcement.getAnnouncementsPaged.invalidate();
    },
  });

  function handleSubmit(data: z.infer<typeof schema>) {
    const startsAtUtc = dayjs.utc(data.startsAt).toDate();
    const isToday = startsAtUtc.toDateString() === new Date().toDateString();
    mutate({
      ...announcement,
      ...data,
      title: data.title.trim(),
      content: data.content.trim(),
      startsAt: isToday
        ? startsAtRef.current ?? startsAtUtc
        : startOfDay(data.startsAt, { utc: true }),
      endsAt: endOfDay(data.endsAt, { utc: true }),
      metadata: {
        actions:
          data.linkText && data.linkUrl
            ? [{ type: 'button', link: data.linkUrl, linkText: data.linkText }]
            : undefined,
        image: data.image,
      },
    });
  }

  const renderSelectOption: SelectProps['renderOption'] = ({ option, checked }) => {
    return (
      <div>
        <div className="flex items-center gap-2">
          <span>{option.label}</span>
          <ColorSwatch size={18} color={theme.colors[option.label][4]} />
        </div>
      </div>
    );
  };

  return (
    <Modal {...dialog} title={`${announcement?.id ? 'Edit' : 'Save'} Announcement`}>
      <Form form={form} onSubmit={handleSubmit} className="flex flex-col gap-3">
        <InputText name="title" label="Title" />
        <InputTextArea name="content" label="Content" autosize />

        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
          <InputText name="image" label="Image ID" />
          <InputSelect
            name="color"
            label="Color"
            data={colors.map((color) => ({ value: color, label: color }))}
            renderOption={renderSelectOption}
            searchable
            clearable
          />
        </div>

        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
          <InputDatePicker
            name="startsAt"
            label="Starts At"
            onChange={(value) => {
              startsAtRef.current = value ? new Date() : null;
            }}
          />
          <InputDatePicker name="endsAt" label="Ends At" />
        </div>

        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
          <InputText name="linkText" label="CTA Text" />
          <InputText name="linkUrl" label="CTA Url" />
        </div>

        <InputCheckbox name="disabled" label="Disabled" />
        <Button type="submit" loading={isLoading}>
          Save
        </Button>
      </Form>
    </Modal>
  );
}
