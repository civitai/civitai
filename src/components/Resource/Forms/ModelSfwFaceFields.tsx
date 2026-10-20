import { Button, Group, Loader, Paper, Stack, Switch, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
  IconSparkles,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { InputRTE, InputText } from '~/libs/form';
import type { SfwFaceCheckField, SfwFaceVerdict } from '~/server/services/model-sfw-face.service';
import { normalizeSfwFaceText } from '~/shared/utils/model-sfw-face';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type SfwFaceForm = {
  name: string;
  description?: string | null;
  sfwName?: string | null;
  sfwDescription?: string | null;
  sfwCoverImageId?: number | null;
};

const CHECK_DEBOUNCE_MS = 800;

/**
 * The model's .com title and description. Off means one title and description for both sites;
 * a null `sfwName` is how the server stores "off".
 */
export function ModelSfwFaceFields({ modelId }: { modelId?: number }) {
  const form = useFormContext<SfwFaceForm>();
  const [sfwName, sfwDescription] = useWatch({
    control: form.control,
    name: ['sfwName', 'sfwDescription'],
  });
  const enabled = sfwName != null;

  const nameVerdict = useSfwFaceVerdict('sfwName', enabled ? sfwName : null);
  const descriptionVerdict = useSfwFaceVerdict('sfwDescription', enabled ? sfwDescription : null);
  const versionsVerdict = useVersionsVerdict(enabled ? modelId : undefined);

  const setFace = (name: string | null, description: string | null) => {
    form.setValue('sfwName', name, { shouldDirty: true, shouldValidate: name !== null });
    form.setValue('sfwDescription', description, { shouldDirty: true });
    if (name === null) form.setValue('sfwCoverImageId', null, { shouldDirty: true });
  };

  const draftMutation = trpc.model.draftSfwFace.useMutation({
    onSuccess: (draft) => setFace(draft.sfwName, draft.sfwDescription),
    onError: (error) =>
      showErrorNotification({ title: 'Could not draft', error: new Error(error.message) }),
  });

  const handleDraft = () => {
    const { name, description, sfwName: currentName } = form.getValues();
    const draft = () => draftMutation.mutate({ name, description, modelId });
    if (!currentName || currentName === name) return draft();

    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Replace your .com content?',
        message: 'The draft replaces the .com title and description you have now.',
        labels: { confirm: 'Replace', cancel: 'Keep mine' },
        onConfirm: draft,
      },
    });
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
            <Group justify="space-between" gap="xs">
              <Text size="xs" c="dimmed">
                Start from a draft written from your current title and description.
              </Text>
              <Button
                size="compact-sm"
                variant="light"
                leftSection={<IconSparkles size={14} />}
                loading={draftMutation.isPending}
                onClick={handleDraft}
              >
                Draft a civitai.com version
              </Button>
            </Group>
            <Stack gap={4}>
              <VerdictLine verdict={nameVerdict} />
              <InputText
                name="sfwName"
                label=".com title"
                placeholder="Title shown on civitai.com"
                withAsterisk
              />
            </Stack>
            <Stack gap={4}>
              <VerdictLine verdict={descriptionVerdict} />
              <InputRTE
                name="sfwDescription"
                label=".com description"
                description="Leave it empty to show no description on civitai.com."
                includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
                editorSize="xl"
                placeholder="What does your model do, described for civitai.com?"
              />
            </Stack>
            {versionsVerdict?.verdict?.status === 'flagged' && (
              <VerdictLine
                verdict={versionsVerdict}
                subject="Some version names or trigger words"
                plural
              />
            )}
            <Text size="xs" c="dimmed">
              Version descriptions are not shown on civitai.com while this is on.
            </Text>
          </>
        )}
      </Stack>
    </Paper>
  );
}

type VerdictState = { checking: boolean; verdict?: SfwFaceVerdict };

function useSfwFaceVerdict(
  field: Exclude<SfwFaceCheckField, 'versions'>,
  value: string | null | undefined
): VerdictState | undefined {
  const [debounced] = useDebouncedValue(normalizeSfwFaceText(value), CHECK_DEBOUNCE_MS);
  const [state, setState] = useState<VerdictState>();
  const { mutateAsync } = trpc.model.checkSfwFace.useMutation();

  useEffect(() => {
    if (!debounced) {
      setState(undefined);
      return;
    }
    let superseded = false;
    setState({ checking: true });
    mutateAsync({ [field]: debounced })
      .then((verdicts) => !superseded && setState({ checking: false, verdict: verdicts[field] }))
      .catch(
        () => !superseded && setState({ checking: false, verdict: { status: 'unavailable' } })
      );
    return () => {
      superseded = true;
    };
  }, [debounced, field, mutateAsync]);

  return state;
}

function useVersionsVerdict(modelId: number | undefined): VerdictState | undefined {
  const [state, setState] = useState<VerdictState>();
  const { mutateAsync } = trpc.model.checkSfwFace.useMutation();

  useEffect(() => {
    if (!modelId) return;
    let superseded = false;
    mutateAsync({ modelId })
      .then((verdicts) => !superseded && setState({ checking: false, verdict: verdicts.versions }))
      .catch(() => undefined);
    return () => {
      superseded = true;
    };
  }, [modelId, mutateAsync]);

  return state;
}

function VerdictLine({
  verdict: state,
  subject = 'This',
  plural = false,
}: {
  verdict?: VerdictState;
  subject?: string;
  plural?: boolean;
}) {
  if (!state) return null;
  if (state.checking)
    return (
      <Group gap={6}>
        <Loader size={12} />
        <Text size="xs" c="dimmed">
          Checking for civitai.com…
        </Text>
      </Group>
    );

  const { verdict } = state;
  if (verdict?.status === 'clean')
    return (
      <Group gap={6}>
        <IconCircleCheck size={14} color="var(--mantine-color-green-6)" />
        <Text size="xs" c="green">
          Suitable for civitai.com
        </Text>
      </Group>
    );

  if (verdict?.status === 'flagged') {
    const reason = verdict.labels.join(', ');
    const terms = verdict.terms.length ? `: “${verdict.terms.slice(0, 5).join('”, “')}”` : '';
    return (
      <Group gap={6} wrap="nowrap" align="flex-start">
        <IconAlertTriangle size={14} color="var(--mantine-color-red-6)" className="shrink-0" />
        <Text size="xs" c="red">
          {subject} {plural ? 'aren’t' : 'isn’t'} suitable for civitai.com ({reason}){terms}
        </Text>
      </Group>
    );
  }

  return (
    <Group gap={6}>
      <IconInfoCircle size={14} color="var(--mantine-color-gray-6)" />
      <Text size="xs" c="dimmed">
        Couldn&apos;t check this right now. It is checked again when you save.
      </Text>
    </Group>
  );
}
