import {
  Button,
  Divider,
  Group,
  Modal,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import { HubSourceEditor } from '~/components/Hubs/HubSourceEditor';
import { BrowsingLevelsInput } from '~/components/BrowsingLevel/BrowsingLevelInput';
import { useSortAvailability } from '~/components/Filters/useSortAvailability';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { defaultHubSort } from '~/components/Hubs/hub-sort';
import { hubUrl, useInvalidateHub } from '~/components/Hubs/hub.utils';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { Availability } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function HubUpsertModal({
  hub,
  duplicateOf,
}: {
  /** Omitted to create. */
  hub?: {
    id: number;
    name: string;
    description?: string | null;
    availability: Availability;
  };
  /**
   * Creating a copy of someone else's hub. Prefills the name and the sources so the
   * copier renames before saving (subtask 868kwp5j3); nothing is written until they
   * do, and the copy has no link back to the original.
   */
  duplicateOf?: { name: string; forcedBrowsingLevel: number; sources: HubSourceValue[] };
}) {
  const dialog = useDialogContext();
  const router = useRouter();
  const invalidateHub = useInvalidateHub();
  const editing = !!hub;
  const defaultSort = defaultHubSort(useSortAvailability());
  const features = useFeatureFlags();

  const [name, setName] = useState(hub?.name ?? duplicateOf?.name ?? '');
  const [description, setDescription] = useState(hub?.description ?? '');
  const [sources, setSources] = useState<HubSourceValue[]>(duplicateOf?.sources ?? []);
  const [isPublic, setIsPublic] = useState(hub?.availability === Availability.Public);
  // Creation only. Once a hub exists the level lives in its Sources panel, beside the
  // sources it applies to — the edit modal deliberately does not carry it.
  const [forcedBrowsingLevel, setForcedBrowsingLevel] = useState(
    duplicateOf?.forcedBrowsingLevel ?? 0
  );

  const upsert = trpc.userHub.upsert.useMutation({
    onSuccess: async (saved) => {
      // Closed first: invalidating the feed waits on its refetch, and nothing this
      // modal saves is something the feed reads.
      dialog.onClose();
      await invalidateHub(saved.id);
      if (!editing) await router.push(hubUrl(saved));
    },
    onError: (error) =>
      showErrorNotification({
        title: editing ? 'Could not save hub' : 'Could not create hub',
        error: new Error(error.message),
      }),
  });

  const trimmed = name.trim();

  const handleSave = () => {
    if (!trimmed) return;
    upsert.mutate({
      id: hub?.id,
      name: trimmed,
      description: description.trim(),
      availability: isPublic ? Availability.Public : Availability.Private,
      // Editing leaves the source list alone: the rail owns it, and resending an
      // empty array here would wipe it. The sort goes with creation for the same
      // reason it is resolved on read — storing one this viewer cannot pick would
      // strand them on it.
      ...(editing
        ? {}
        : {
            sort: defaultSort,
            forcedBrowsingLevel,
            sources: sources.map((s, index) => ({ ...s, index })),
          }),
    });
  };

  return (
    <Modal
      {...dialog}
      title={
        <Text fw={600}>{editing ? 'Edit hub' : duplicateOf ? 'Duplicate hub' : 'New hub'}</Text>
      }
      size="lg"
    >
      <Stack gap="md">
        <TextInput
          label="Name"
          placeholder="Anime creators I follow"
          data-autofocus
          value={name}
          maxLength={hubLimits.nameLength}
          disabled={upsert.isPending}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Textarea
          label="Description"
          placeholder="What goes in this hub?"
          autosize
          minRows={2}
          maxRows={5}
          value={description}
          maxLength={hubLimits.descriptionLength}
          disabled={upsert.isPending}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />

        <Switch
          label="Anyone with the link can view this hub"
          description="Hubs are private until you turn this on. Turning it back off makes every link you shared stop working."
          checked={isPublic}
          disabled={upsert.isPending}
          onChange={(event) => setIsPublic(event.currentTarget.checked)}
        />

        {!editing && features.canViewNsfw && (
          <BrowsingLevelsInput
            label="Content levels"
            description={
              forcedBrowsingLevel
                ? 'Only these levels show in this hub.'
                : 'No limit — the browsing settings of whoever is looking decide.'
            }
            value={forcedBrowsingLevel}
            allowEmpty
            onChange={setForcedBrowsingLevel}
          />
        )}

        {!editing && (
          <>
            <Divider label="Sources" labelPosition="left" />
            <HubSourceEditor
              value={sources}
              onChange={setSources}
              disabled={upsert.isPending}
              emptyMessage="Add a creator or a model now, or leave it empty and fill it from the rail."
            />
          </>
        )}

        <Group justify="flex-end">
          <Button variant="default" disabled={upsert.isPending} onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button loading={upsert.isPending} disabled={!trimmed} onClick={handleSave}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
