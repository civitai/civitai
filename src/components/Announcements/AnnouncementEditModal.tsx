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
  InputMultiSelect,
  InputSelect,
  InputSimpleImageUpload,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import {
  ANNOUNCEMENT_IMAGE_WIDTH,
  announcementImageFormSchema,
  toAnnouncementImageKey,
} from '~/components/Announcements/announcement-image';
import type { UpsertAnnouncementSchema } from '~/server/schema/announcement.schema';
import { DomainColor } from '~/shared/utils/prisma/enums';
import { dateWithoutTimezone, endOfDay, startOfDay } from '~/utils/date-helpers';
import { capitalize } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  title: z.string(),
  content: z.string(),
  color: z.string(),
  domain: z.enum(DomainColor).array().default([DomainColor.all]),
  startsAt: z.date(),
  endsAt: z.date().nullish(),
  image: announcementImageFormSchema,
  disabled: z.boolean().optional(),
  linkText: z.string().optional(),
  linkUrl: z.string().optional(),
});

const domainColorOptions = Object.values(DomainColor).map((domain) => ({
  value: domain,
  label: `${capitalize(domain)} ${domain === DomainColor.all ? 'Servers' : 'Server'}`,
}));

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
      domain: announcement?.domain ?? [DomainColor.all],
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

  const { mutate, isPending: isLoading } = trpc.announcement.upsertAnnouncement.useMutation({
    onSuccess: () => {
      dialog.onClose();
      queryUtils.announcement.getAnnouncementsPaged.invalidate();
    },
  });

  function handleSubmit({ image, ...data }: z.infer<typeof schema>) {
    const startsAtUtc = dayjs.utc(data.startsAt).toDate();
    const isToday = startsAtUtc.toDateString() === new Date().toDateString();
    const { domain } = data;

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
        // Wire format is unchanged: a bare object key string (or undefined).
        image: toAnnouncementImageKey(image),
      },
      domain: domain.length ? domain : [DomainColor.all],
    });
  }

  const renderSelectOption: SelectProps['renderOption'] = ({ option }) => {
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

        <InputMultiSelect
          name="domain"
          label="Domain"
          description="Select which server domains this announcement should appear on"
          data={domainColorOptions}
          placeholder="Select domains..."
          searchable
          clearable
        />

        {/*
          Banner upload — deliberately does NOT create an `Image` row.

          `SimpleImageUpload` uploads via `/api/v1/image-upload`, which mints an object
          key and a presigned PUT and nothing else. That is the point: `deleteImageFromS3`
          is row-scoped, not bucket-scoped — every one of its call sites hands it an
          `Image` row's id and url. A key that is not any `Image.url` therefore cannot be
          reached by any deletion path in the app, so the banner cannot be deleted out
          from under a live announcement. That is exactly the failure that broke a
          sitewide announcement banner for every user. Membership badges already use this
          same no-row pattern.

          🔴 DO NOT "fix" this by adding a `createImage` / `dbWrite.image` call here.
          Creating the row is what makes the object deletable, which reintroduces the bug.

          🔴 Accepted, documented cost: these keys are intentionally UNREGISTERED — no
          `Image` row, so no garbage collector will ever reclaim them. Any future
          orphan-cleanup job over the uploads bucket keyed on "object has no `Image` row"
          MUST exclude keys referenced by `Announcement.metadata->>'image'` (and the other
          bare-key media pointers: `Cosmetic.data.url`, `Tool.icon`/`metadata.header`,
          `Partner.logo`, `User.image`), or it will reproduce this outage from a new
          direction. `~/server/jobs/announcement-media-check` monitors for exactly that.
        */}
        <InputSimpleImageUpload
          name="image"
          label="Banner Image"
          description="Shown alongside the announcement. Uploads are stored as a bare object key."
          previewWidth={ANNOUNCEMENT_IMAGE_WIDTH}
          withNsfwLevel={false}
        />

        <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
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
