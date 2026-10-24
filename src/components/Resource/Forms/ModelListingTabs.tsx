import {
  Alert,
  Badge,
  Button,
  Group,
  Input,
  Loader,
  Paper,
  Stack,
  Tabs,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
  IconSparkles,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useFormContext, useFormState, useWatch } from 'react-hook-form';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { InputRTE, InputText } from '~/libs/form';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { SfwFaceCheckField, SfwFaceVerdict } from '~/server/services/model-sfw-face.service';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { normalizeSfwFaceText } from '~/shared/utils/model-sfw-face';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type ListingForm = {
  name: string;
  description?: string | null;
  nsfw?: boolean;
  sfwName?: string | null;
  sfwDescription?: string | null;
  coverImageId?: number | null;
  sfwCoverImageId?: number | null;
};

type Site = 'red' | 'com';

const CHECK_DEBOUNCE_MS = 800;

/**
 * The model's listing per site. The civitai.red tab holds the title and description passed in as
 * `redFields`; the civitai.com tab is the same listing until the creator gives .com its own. A null
 * `sfwName` is how the server stores "the same".
 */
export function ModelListingTabs({
  modelId,
  redFields,
}: {
  modelId?: number;
  redFields: ReactNode;
}) {
  const form = useFormContext<ListingForm>();
  const [sfwName, sfwDescription] = useWatch({
    control: form.control,
    name: ['sfwName', 'sfwDescription'],
  });
  const { errors, submitCount } = useFormState({ control: form.control });
  const [site, setSite] = useState<Site>('red');
  const ownComContent = sfwName != null;

  const nameVerdict = useSfwFaceVerdict('sfwName', ownComContent ? sfwName : null);
  const descriptionVerdict = useSfwFaceVerdict(
    'sfwDescription',
    ownComContent ? sfwDescription : null
  );
  const versionsVerdict = useVersionsVerdict(ownComContent ? modelId : undefined);

  const redHasErrors = !!(errors.name || errors.description);
  const comHasErrors =
    !!errors.sfwName ||
    nameVerdict?.verdict?.status === 'flagged' ||
    descriptionVerdict?.verdict?.status === 'flagged';

  // A refused submit opens the tab holding the field that refused it.
  useEffect(() => {
    if (!submitCount) return;
    if (redHasErrors) setSite('red');
    else if (errors.sfwName) setSite('com');
  }, [submitCount]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="xs">
        <div>
          <Text fw={600} size="sm">
            Title, description &amp; cover
          </Text>
          <Text size="xs" c="dimmed">
            The only parts of the listing that differ between civitai.com and civitai.red —
            everything else about this model is shared across both sites.
          </Text>
        </div>
        <Tabs value={site} onChange={(value) => value && setSite(value as Site)} keepMounted>
          <Tabs.List>
            <Tabs.Tab value="red" rightSection={redHasErrors ? <ErrorDot /> : undefined}>
              civitai.red
            </Tabs.Tab>
            <Tabs.Tab
              value="com"
              rightSection={
                comHasErrors ? (
                  <ErrorDot />
                ) : (
                  <Badge size="xs" variant="light" color={ownComContent ? 'green' : 'gray'}>
                    {ownComContent ? 'Own content' : 'Same as .red'}
                  </Badge>
                )
              }
            >
              civitai.com
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="red" pt="md">
            <Stack>
              {redFields}
              {modelId && <SiteCoverPicker site="red" modelId={modelId} />}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="com" pt="md">
            <ComListing
              modelId={modelId}
              ownContent={ownComContent}
              nameVerdict={nameVerdict}
              descriptionVerdict={descriptionVerdict}
              versionsVerdict={versionsVerdict}
            />
          </Tabs.Panel>
        </Tabs>
        {!modelId && (
          <Text size="xs" c="dimmed">
            You can select your main cover after you publish this model&apos;s first images. A
            default cover will be selected for you from there.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

function ComListing({
  modelId,
  ownContent,
  nameVerdict,
  descriptionVerdict,
  versionsVerdict,
}: {
  modelId?: number;
  ownContent: boolean;
  nameVerdict?: VerdictState;
  descriptionVerdict?: VerdictState;
  versionsVerdict?: VerdictState;
}) {
  const form = useFormContext<ListingForm>();

  const setComContent = (name: string | null, description: string | null) => {
    form.setValue('sfwName', name, { shouldDirty: true, shouldValidate: name !== null });
    form.setValue('sfwDescription', description, { shouldDirty: true });
    if (name === null) form.setValue('sfwCoverImageId', null, { shouldDirty: true });
  };

  const draftMutation = trpc.model.draftSfwFace.useMutation({
    onSuccess: (draft) => setComContent(draft.sfwName, draft.sfwDescription),
    onError: (error) =>
      showErrorNotification({ title: 'Could not draft', error: new Error(error.message) }),
  });

  const handleDraft = () => {
    const { name, description, sfwName } = form.getValues();
    const draft = () => draftMutation.mutate({ name, description, modelId });
    if (!sfwName || sfwName === name) return draft();

    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Replace your civitai.com content?',
        message: 'The draft replaces the civitai.com title and description you have now.',
        labels: { confirm: 'Replace', cancel: 'Keep mine' },
        onConfirm: draft,
      },
    });
  };

  const handleUseRed = () =>
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Show the civitai.red listing on civitai.com?',
        message:
          'The civitai.com title, description and cover are removed, and civitai.com shows the same listing as civitai.red.',
        labels: { confirm: 'Use the civitai.red listing', cancel: 'Keep it' },
        confirmProps: { color: 'red' },
        onConfirm: () => setComContent(null, null),
      },
    });

  const draftButton = (
    <Button
      variant="light"
      leftSection={<IconSparkles size={16} />}
      loading={draftMutation.isPending}
      onClick={handleDraft}
    >
      Draft a civitai.com version
    </Button>
  );

  if (!ownContent)
    return (
      <Stack gap="sm" align="flex-start">
        <Text size="sm">civitai.com shows the same title and description as civitai.red.</Text>
        <Text size="sm" c="dimmed">
          civitai.com shows no mature content. Give it its own listing when yours is meant for
          civitai.red.
        </Text>
        <Group gap="xs">
          <Button
            variant="default"
            onClick={() => {
              const { name, description } = form.getValues();
              setComContent(name, description ?? '');
            }}
          >
            Write a civitai.com version
          </Button>
          {draftButton}
        </Group>
      </Stack>
    );

  return (
    <Stack>
      <Group justify="space-between" gap="xs">
        <Text size="xs" c="dimmed">
          Checked for mature content as you type.
        </Text>
        {draftButton}
      </Group>
      <Stack gap={4}>
        <VerdictLine verdict={nameVerdict} />
        <InputText
          name="sfwName"
          label="Title"
          placeholder="Title shown on civitai.com"
          withAsterisk
        />
      </Stack>
      <Stack gap={4}>
        <VerdictLine verdict={descriptionVerdict} />
        <InputRTE
          name="sfwDescription"
          label="Description"
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
      {modelId && <SiteCoverPicker site="com" modelId={modelId} />}
      <Group justify="space-between" gap="xs">
        <Text size="xs" c="dimmed">
          Version descriptions are not shown on civitai.com while it has its own listing.
        </Text>
        <Button variant="subtle" color="red" size="compact-sm" onClick={handleUseRed}>
          Use the civitai.red listing
        </Button>
      </Group>
    </Stack>
  );
}

const isSafeLevel = (nsfwLevel: number) =>
  !!nsfwLevel && (nsfwLevel & sfwBrowsingLevelsFlag) === nsfwLevel;

/** The cover a site leads with, picked from the creator's own published images on the model. */
function SiteCoverPicker({ site, modelId }: { site: Site; modelId: number }) {
  const features = useFeatureFlags();
  const form = useFormContext<ListingForm>();
  const field = site === 'com' ? 'sfwCoverImageId' : 'coverImageId';
  const [nsfw, value] = useWatch({ control: form.control, name: ['nsfw', field] });
  const { data: candidates = [], isLoading } = trpc.model.getCoverCandidates.useQuery({
    id: modelId,
  });

  if (site === 'red' && !features.canViewNsfw)
    return (
      <Text size="xs" c="dimmed">
        Pick the civitai.red cover from civitai.red.
      </Text>
    );

  const images = site === 'com' ? candidates.filter((i) => isSafeLevel(i.nsfwLevel)) : candidates;
  const description =
    site === 'com'
      ? 'Only your images rated PG or PG-13 can lead on civitai.com. Click a picked image again to clear it.'
      : 'Without a pick, the first image of your latest version leads. Click a picked image again to clear it.';

  return (
    <Stack gap="xs">
      <Input.Wrapper label="Cover" description={description}>
        {isLoading ? (
          <Loader size="sm" mt="xs" />
        ) : !images.length ? (
          <Text size="xs" c="dimmed" mt="xs">
            {candidates.length
              ? 'None of your images on this model are rated PG or PG-13 yet.'
              : 'Publish a post with images on this model to pick a cover.'}
          </Text>
        ) : (
          <Group gap="xs" mt="xs">
            {images.map((image) => {
              const selected = image.id === value;
              return (
                <UnstyledButton
                  key={image.id}
                  type="button"
                  aria-label={`Use image ${image.id} as the civitai.${site} cover`}
                  aria-pressed={selected}
                  onClick={() =>
                    form.setValue(field, selected ? null : image.id, { shouldDirty: true })
                  }
                  className={clsx(
                    'overflow-hidden rounded-md border-2 border-solid',
                    selected ? 'border-blue-5' : 'border-transparent'
                  )}
                >
                  <EdgeMedia2
                    src={image.url}
                    type={image.type}
                    metadata={image.metadata as never}
                    width={90}
                    anim={false}
                    className="size-[90px] object-cover"
                  />
                </UnstyledButton>
              );
            })}
          </Group>
        )}
      </Input.Wrapper>
      {site === 'com' && nsfw && !value && (
        <Alert color="yellow" p="xs">
          <Text size="xs">
            This model is marked mature, so it stays off civitai.com until you pick a civitai.com
            cover.
          </Text>
        </Alert>
      )}
    </Stack>
  );
}

function ErrorDot() {
  return <span className="block size-2 rounded-full bg-red-6" aria-label="Needs attention" />;
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

  if (verdict?.status === 'flagged')
    return (
      <Group gap={6} wrap="nowrap" align="flex-start">
        <IconAlertTriangle size={14} color="var(--mantine-color-red-6)" className="shrink-0" />
        <Text size="xs" c="red">
          {subject} {plural ? 'aren’t' : 'isn’t'} suitable for civitai.com (rated {verdict.level}).{' '}
          {verdict.reason}
        </Text>
      </Group>
    );

  return (
    <Group gap={6}>
      <IconInfoCircle size={14} color="var(--mantine-color-gray-6)" />
      <Text size="xs" c="dimmed">
        Couldn&apos;t check this right now. It is checked again when you save.
      </Text>
    </Group>
  );
}
