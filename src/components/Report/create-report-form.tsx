import { Stack } from '@mantine/core';
import type { Dispatch, SetStateAction } from 'react';
import { useMemo, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type * as z from 'zod';
import { useReportTarget } from '~/components/Report/report-target.context';
import { songReportStartSec, songReportTimeSchema } from '~/components/Report/song-report-time';
import { Form, InputText, useForm } from '~/libs/form';
import { formatPlaybackTime } from '~/utils/audio-player';

type ReportFormContext<TSchema extends z.ZodObject> = {
  schema: TSchema;
  form: UseFormReturn<z.input<TSchema>, any, z.output<TSchema>>;
};

type ReportFormProps<TSchema extends z.ZodObject> = {
  context: ReportFormContext<TSchema>;
  props: {
    setUploading: Dispatch<SetStateAction<boolean>>;
  };
};

export const createReportForm = <TSchema extends z.ZodObject>({
  schema,
  Element,
}: {
  schema: TSchema;
  Element:
    | React.ForwardRefExoticComponent<ReportFormProps<TSchema>>
    | ((props: ReportFormProps<TSchema>) => JSX.Element);
}) => {
  function ReportForm({
    onSubmit,
    setUploading,
    children,
  }: {
    onSubmit: (values: z.infer<TSchema>) => void;
    setUploading: Dispatch<SetStateAction<boolean>>;
    children: React.ReactNode;
  }) {
    const target = useReportTarget();
    const song = target?.song;
    // Read once, when the form opens: the song keeps playing while it is filled in.
    const [startSec] = useState(() => (target && song ? songReportStartSec(target.entityId) : 0));
    // A report on a song says when in the song (timestampSec), as m:ss.
    const formSchema = useMemo(
      () =>
        song
          ? (schema.safeExtend({
              timestampSec: songReportTimeSchema(song.durationSec),
            }) as unknown as TSchema)
          : schema,
      [song]
    );
    const form = useForm({
      schema: formSchema,
      shouldUnregister: false,
      defaultValues: song
        ? ({ timestampSec: formatPlaybackTime(startSec) } as z.input<TSchema>)
        : undefined,
    });

    return (
      <Form form={form} onSubmit={onSubmit}>
        <Stack>
          {song && (
            <InputText
              name="timestampSec"
              label="Time in the song"
              description="When in the song this happens, as m:ss."
              withAsterisk
            />
          )}
          <Element context={{ form, schema }} props={{ setUploading }} />
          {children}
        </Stack>
      </Form>
    );
  }
  return ReportForm;
};
