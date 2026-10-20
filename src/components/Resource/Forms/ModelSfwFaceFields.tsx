import { Paper, Stack, Switch, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { InputRTE, InputText } from '~/libs/form';

type SfwFaceForm = {
  name: string;
  description?: string | null;
  sfwName?: string | null;
  sfwDescription?: string | null;
};

export type SfwFaceField = 'sfwName' | 'sfwDescription';

/**
 * The model's .com title and description. Off means one title and description for both sites;
 * a null `sfwName` is how the server stores "off".
 */
export function ModelSfwFaceFields({
  fieldStatus,
}: {
  /** Rendered above each .com field, e.g. the content check's verdict. */
  fieldStatus?: (field: SfwFaceField) => ReactNode;
}) {
  const form = useFormContext<SfwFaceForm>();
  const sfwName = useWatch({ control: form.control, name: 'sfwName' });
  const enabled = sfwName != null;

  const setFace = (name: string | null, description: string | null) => {
    form.setValue('sfwName', name, { shouldDirty: true, shouldValidate: name !== null });
    form.setValue('sfwDescription', description, { shouldDirty: true });
  };

  const handleToggle = (checked: boolean) => {
    if (checked) {
      const { name, description } = form.getValues();
      setFace(name, description ?? '');
      return;
    }

    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Use the same content on both sites?',
        message:
          'The .com title and description will be removed, and civitai.com will show the same title and description as civitai.red.',
        labels: { confirm: 'Remove .com content', cancel: 'Keep it' },
        confirmProps: { color: 'red' },
        onConfirm: () => setFace(null, null),
      },
    });
  };

  return (
    <Paper radius="md" p="md" withBorder>
      <Stack gap="md">
        <Switch
          checked={enabled}
          onChange={(event) => handleToggle(event.currentTarget.checked)}
          label="Different title and description for civitai.com"
          description="civitai.com shows no mature content. Give it its own title and description when yours are meant for civitai.red."
        />
        {enabled && (
          <>
            <Stack gap={4}>
              {fieldStatus?.('sfwName')}
              <InputText
                name="sfwName"
                label=".com title"
                placeholder="Title shown on civitai.com"
                withAsterisk
              />
            </Stack>
            <Stack gap={4}>
              {fieldStatus?.('sfwDescription')}
              <InputRTE
                name="sfwDescription"
                label=".com description"
                description="Leave it empty to show no description on civitai.com."
                includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
                editorSize="xl"
                placeholder="What does your model do, described for civitai.com?"
              />
            </Stack>
            <Text size="xs" c="dimmed">
              Version descriptions are not shown on civitai.com while this is on.
            </Text>
          </>
        )}
      </Stack>
    </Paper>
  );
}
