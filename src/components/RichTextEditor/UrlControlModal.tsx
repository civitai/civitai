import { Button, Input, Modal } from '@mantine/core';
import * as z from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

export function UrlControlModal({
  title,
  onSuccess,
  label,
  placeholder,
  regex,
}: {
  title: string;
  onSuccess: (args: { url: string }) => void;
  label: string;
  placeholder: string;
  regex: RegExp;
}) {
  const dialog = useDialogContext();

  const schema = z.object({
    url: z.url().regex(regex, `Please provide an ${label}`),
  });

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { url: '' },
    shouldUnregister: false,
  });

  const handleSubmit = (values: z.infer<typeof schema>) => {
    onSuccess(values);
    dialog.onClose();
  };

  return (
    <Modal title={title} {...dialog}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="flex flex-col gap-1">
        <Controller
          control={form.control}
          name="url"
          render={({ field }) => (
            <Input {...field} label={label} placeholder={placeholder} withAsterisk />
          )}
        />

        <Button type="submit" fullWidth>
          Submit
        </Button>
      </form>
    </Modal>
  );
}
