/**
 * Moderator UI for generator-related runtime config (Redis-backed).
 *
 * Currently hosts the ecosystem-config form (six gating arrays consumed by
 * `getResourceCanGenerate`). Future generator config sections — unrelated
 * to ecosystem gating — should be added as additional sections on this
 * page rather than spawning new pages.
 *
 * Testing scopes (ecosystems & IDs) are gated behind the `generation-testing`
 * Flipt flag — assign users to that flag in Flipt to grant testing access.
 */

import {
  Alert,
  Button,
  Container,
  Divider,
  Group,
  Loader,
  Stack,
  TagsInput,
  Text,
  Title,
} from '@mantine/core';
import { IconDeviceFloppy, IconInfoCircle } from '@tabler/icons-react';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { Page } from '~/components/AppLayout/Page';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ecosystemByKey, ecosystems } from '~/shared/constants/basemodel.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };
    return { props: {} };
  },
});

type EcosystemConfigForm = {
  modOnlyEcosystems: string[];
  disabledEcosystems: string[];
  testingEcosystems: string[];
  experimentalEcosystems: string[];
  modOnlyIds: string[];
  disabledIds: string[];
  testingIds: string[];
};

const EMPTY_FORM: EcosystemConfigForm = {
  modOnlyEcosystems: [],
  disabledEcosystems: [],
  testingEcosystems: [],
  experimentalEcosystems: [],
  modOnlyIds: [],
  disabledIds: [],
  testingIds: [],
};

/** Parse a TagsInput value (strings) into positive integers; returns the bad entries separately. */
function parseIds(values: string[] | undefined): { ids: number[]; invalid: string[] } {
  const ids: number[] = [];
  const invalid: string[] = [];
  for (const raw of values ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n > 0) ids.push(n);
    else invalid.push(raw);
  }
  return { ids: Array.from(new Set(ids)), invalid };
}

/** Strip empty / whitespace-only entries and dedupe — keeps free-form keys as-is. */
function normalizeKeys(values: string[] | undefined): string[] {
  return Array.from(
    new Set((values ?? []).map((v) => v.trim()).filter((v): v is string => v.length > 0))
  );
}

function EcosystemConfigSection() {
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.generation.getEcosystemConfig.useQuery();

  const [form, setForm] = useState<EcosystemConfigForm>(EMPTY_FORM);

  // Hydrate the form once the query resolves. Each field gets `?? []` so a
  // legacy Redis value (or a stale client-side cache) that's missing a newer
  // key still produces a usable empty array instead of `undefined`.
  useEffect(() => {
    if (!data) return;
    setForm({
      modOnlyEcosystems: data.modOnlyEcosystems ?? [],
      disabledEcosystems: data.disabledEcosystems ?? [],
      testingEcosystems: data.testingEcosystems ?? [],
      experimentalEcosystems: data.experimentalEcosystems ?? [],
      modOnlyIds: (data.modOnlyIds ?? []).map(String),
      disabledIds: (data.disabledIds ?? []).map(String),
      testingIds: (data.testingIds ?? []).map(String),
    });
  }, [data]);

  // Suggestion list for the ecosystem TagsInputs. Mantine's TagsInput stores
  // the picked string verbatim (it uses the option's `label`, which must
  // equal `value` — see TagsInput.mjs#onOptionSubmit), so we pass plain
  // ecosystem keys here. The dropdown is then dressed up via `renderOption`
  // below to show "<displayName> (<key>)". Free-form entries are also
  // accepted, so any key not in this list still works.
  const ecosystemSuggestions = useMemo(
    () => [...ecosystems].sort((a, b) => a.sortOrder - b.sortOrder).map((e) => e.key),
    []
  );

  const renderEcosystemOption = useCallback(
    ({ option }: { option: { value: string } }) => {
      const eco = ecosystemByKey.get(option.value);
      if (!eco) return option.value;
      return (
        <span>
          <Text span fw={500}>
            {eco.displayName}
          </Text>{' '}
          <Text span c="dimmed" size="xs">
            ({option.value})
          </Text>
        </span>
      );
    },
    []
  );

  const setMutation = trpc.generation.setEcosystemConfig.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Saved',
        message: 'Ecosystem config updated. Changes propagate as caches refresh.',
      });
      queryUtils.generation.getEcosystemConfig.invalidate();
      queryUtils.generation.getGenerationConfig.invalidate();
    },
    onError: (err) =>
      showErrorNotification({ title: 'Save failed', error: new Error(err.message) }),
  });

  const handleSave = () => {
    const modOnlyParsed = parseIds(form.modOnlyIds);
    const disabledParsed = parseIds(form.disabledIds);
    const testingParsed = parseIds(form.testingIds);

    const allInvalid = [
      ...modOnlyParsed.invalid,
      ...disabledParsed.invalid,
      ...testingParsed.invalid,
    ];
    if (allInvalid.length) {
      showErrorNotification({
        title: 'Invalid model version IDs',
        error: new Error(`Not positive integers: ${allInvalid.join(', ')}`),
      });
      return;
    }

    setMutation.mutate({
      modOnlyEcosystems: normalizeKeys(form.modOnlyEcosystems),
      disabledEcosystems: normalizeKeys(form.disabledEcosystems),
      testingEcosystems: normalizeKeys(form.testingEcosystems),
      experimentalEcosystems: normalizeKeys(form.experimentalEcosystems),
      modOnlyIds: modOnlyParsed.ids,
      disabledIds: disabledParsed.ids,
      testingIds: testingParsed.ids,
    });
  };

  if (isLoading) {
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  }

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={3}>Ecosystem gates</Title>
        <Text c="dimmed" size="sm">
          Operator-controlled gating for the generator. Ecosystem-level rules apply to every version
          in that ecosystem; ID-level rules override the ecosystem rule for a single model version.
        </Text>
        <Text c="dimmed" size="sm">
          <b>Disabled</b> = off for everyone (kill-switch, mods included). <b>Mod-only</b> = visible
          to mods only. <b>Testing</b> = visible to mods plus users with the{' '}
          <code>generation-testing</code> Flipt flag. <b>Experimental</b> shows the
          &ldquo;experimental build&rdquo; alert in the generator UI but does not gate access.
        </Text>
      </Stack>

      <Stack gap="md">
        <Title order={5}>Ecosystems</Title>
        <Text c="dimmed" size="xs">
          Pick from the suggestions or type a custom ecosystem key (e.g. an experimental key not yet
          in the dropdown). Press Enter, comma, or space to add.
        </Text>
        <TagsInput
          label="Disabled ecosystems"
          description="Off for everyone, including moderators."
          placeholder="Pick or type an ecosystem key…"
          data={ecosystemSuggestions}
          renderOption={renderEcosystemOption}
          value={form.disabledEcosystems}
          onChange={(v) => setForm((f) => ({ ...f, disabledEcosystems: v }))}
          splitChars={[',', ' ']}
          acceptValueOnBlur
          clearable
        />
        <TagsInput
          label="Mod-only ecosystems"
          description="Hidden from non-moderator users."
          placeholder="Pick or type an ecosystem key…"
          data={ecosystemSuggestions}
          renderOption={renderEcosystemOption}
          value={form.modOnlyEcosystems}
          onChange={(v) => setForm((f) => ({ ...f, modOnlyEcosystems: v }))}
          splitChars={[',', ' ']}
          acceptValueOnBlur
          clearable
        />
        <TagsInput
          label="Testing ecosystems"
          description="Visible to mods and users with the generation-testing Flipt flag."
          placeholder="Pick or type an ecosystem key…"
          data={ecosystemSuggestions}
          renderOption={renderEcosystemOption}
          value={form.testingEcosystems}
          onChange={(v) => setForm((f) => ({ ...f, testingEcosystems: v }))}
          splitChars={[',', ' ']}
          acceptValueOnBlur
          clearable
        />
        <TagsInput
          label="Experimental ecosystems"
          description="Shows the experimental-build alert in the generator UI. Not a gate. Unioned with the static experimental flag baked into base-model records."
          placeholder="Pick or type an ecosystem key…"
          data={ecosystemSuggestions}
          renderOption={renderEcosystemOption}
          value={form.experimentalEcosystems}
          onChange={(v) => setForm((f) => ({ ...f, experimentalEcosystems: v }))}
          splitChars={[',', ' ']}
          acceptValueOnBlur
          clearable
        />
      </Stack>

      <Stack gap="md">
        <Title order={5}>Model version IDs</Title>
        <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
          ID-level rules override ecosystem-level rules. Use these to flip a single version while
          leaving its ecosystem otherwise enabled. Type or paste numeric model version IDs and press
          Enter (or comma).
        </Alert>
        <TagsInput
          label="Disabled IDs"
          description="Off for everyone, including moderators."
          placeholder="e.g. 12345"
          value={form.disabledIds}
          onChange={(v) => setForm((f) => ({ ...f, disabledIds: v }))}
          splitChars={[',', ' ']}
          clearable
        />
        <TagsInput
          label="Mod-only IDs"
          description="Hidden from non-moderator users."
          placeholder="e.g. 12345"
          value={form.modOnlyIds}
          onChange={(v) => setForm((f) => ({ ...f, modOnlyIds: v }))}
          splitChars={[',', ' ']}
          clearable
        />
        <TagsInput
          label="Testing IDs"
          description="Visible to mods and users with the generation-testing Flipt flag."
          placeholder="e.g. 12345"
          value={form.testingIds}
          onChange={(v) => setForm((f) => ({ ...f, testingIds: v }))}
          splitChars={[',', ' ']}
          clearable
        />
      </Stack>

      <Group justify="flex-end">
        <Button
          leftSection={<IconDeviceFloppy size={16} />}
          onClick={handleSave}
          loading={setMutation.isLoading}
        >
          Save ecosystem gates
        </Button>
      </Group>
    </Stack>
  );
}

function GenerationConfigPage() {
  return (
    <>
      <Meta title="Generation Config" deIndex />
      <Container size="md" py="lg">
        <Stack gap="xl">
          <Stack gap={4}>
            <Title order={2}>Generation Config</Title>
            <Text c="dimmed" size="sm">
              Runtime configuration for the generator. Each section saves independently.
            </Text>
          </Stack>

          <Divider />

          <EcosystemConfigSection />
        </Stack>
      </Container>
    </>
  );
}

export default Page(GenerationConfigPage);
