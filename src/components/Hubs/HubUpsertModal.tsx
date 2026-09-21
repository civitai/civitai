import {
  Alert,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { HubSourceValue } from '~/components/Hubs/HubSourceEditor';
import type { HubTemplate } from '~/server/schema/user-hub.schema';
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
  template,
}: {
  /**
   * A starting point from the landing page. The sources are FETCHED and shown here
   * rather than written straight to a new hub: nobody should get a hub they have not
   * seen, and the shortfall when a template cannot fit everything is only legible
   * next to the things that did fit.
   */
  template?: HubTemplate;
  /** Omitted to create. */
  hub?: {
    id: number;
    name: string;
    description?: string | null;
    availability: Availability;
    isOwner: boolean;
    forcedBrowsingLevel?: number;
    sources?: HubSourceValue[];
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
  const [sources, setSources] = useState<HubSourceValue[]>(
    hub?.sources ?? duplicateOf?.sources ?? []
  );
  const [isPublic, setIsPublic] = useState(hub?.availability === Availability.Public);
  const [forcedBrowsingLevel, setForcedBrowsingLevel] = useState(
    hub?.forcedBrowsingLevel ?? duplicateOf?.forcedBrowsingLevel ?? 0
  );

  // What arrived, to compare against on save. `sources` REPLACES the stored list, so
  // sending it unchanged turns a rename into a full rewrite of rows another tab may
  // have just edited — the reason the schema makes the field optional.
  const [initial] = useState(() => ({
    sources: JSON.stringify(hub?.sources ?? []),
    forcedBrowsingLevel: hub?.forcedBrowsingLevel ?? 0,
  }));

  // Sources and the content cap are the owner's to set: the server refuses both from
  // a moderator, so offering them would be a control that always errors.
  const canEditSources = !editing || hub.isOwner;
  const sourcesChanged = JSON.stringify(sources) !== initial.sources;

  // The starting point's sources, dropped into the same fields someone would fill by
  // hand.
  const candidates = trpc.userHub.sourceCandidates.useQuery(
    { template: template as HubTemplate },
    { enabled: !!template }
  );

  // Applied ONCE. A refetch — a refocus, an invalidate — would otherwise throw away
  // whatever the person has pruned since the modal opened, which is the whole point
  // of showing them the list before it is saved.
  const applied = useRef(false);
  useEffect(() => {
    if (!candidates.data || applied.current) return;
    applied.current = true;
    setSources(candidates.data.sources);
    setName((current) => current || candidates.data.name);
  }, [candidates.data]);
  const candidateShortfall = candidates.data
    ? candidates.data.total - candidates.data.sources.length
    : 0;

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

  // A starting point that found nothing explains itself here, where the search box to
  // fix it by hand is already on screen. A FAILED fetch must not borrow that wording:
  // "you are not following anyone" is a claim about someone's account, and a request
  // that never answered has not earned it.
  const emptyMessage = candidates.isError
    ? 'Could not load those — search below, or close and try again.'
    : !template
    ? 'Add a creator, model or tag to start filling this hub.'
    : template === 'my-models'
    ? 'You have no published models yet — search for anything else you want in here.'
    : template === 'bookmarks'
    ? 'You have not bookmarked any models yet — search for anything else you want in here.'
    : 'You are not following anyone yet — search for the creators you want in here.';

  const gathering = {
    'my-models': 'your models',
    following: 'the creators you follow',
    bookmarks: 'your bookmarked models',
  } as const;

  const trimmed = name.trim();

  const handleSave = () => {
    if (!trimmed) return;
    upsert.mutate({
      id: hub?.id,
      name: trimmed,
      description: description.trim(),
      // Omitted rather than resent when the viewer may not change it: a moderator's
      // save must not carry a visibility they were never shown a control for.
      ...(!editing || hub.isOwner
        ? { availability: isPublic ? Availability.Public : Availability.Private }
        : {}),
      // The sort goes with creation only: it is resolved on read, and storing one
      // this viewer cannot pick would strand them on it.
      ...(editing ? {} : { sort: defaultSort }),
      // Sent only when they actually changed. `sources` replaces the stored list and
      // the level is a single write, so resending either unchanged lets a rename
      // clobber an edit made somewhere else since this modal opened.
      ...(canEditSources && (!editing || sourcesChanged)
        ? { sources: sources.map((source, index) => ({ ...source, index })) }
        : {}),
      ...(canEditSources && (!editing || forcedBrowsingLevel !== initial.forcedBrowsingLevel)
        ? { forcedBrowsingLevel }
        : {}),
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

        {/* Owner only. Moderators may rename, re-describe and delete a hub, but
            publishing someone's private curation is a different act from editing
            it — and the Share button is gated the same way, so the two surfaces
            cannot disagree. */}
        {(!editing || hub.isOwner) && (
          <Switch
            label="Anyone with the link can view this hub"
            description="Hubs are private until you turn this on. Turning it back off makes every link you shared stop working."
            checked={isPublic}
            disabled={upsert.isPending}
            onChange={(event) => setIsPublic(event.currentTarget.checked)}
          />
        )}

        {/* A cap on what OTHER people see, so it belongs to sharing: on a private hub
            the only viewer is its owner, whose own browsing settings already decide.
            Shown whenever the switch above is on, and gone when it is off. */}
        {canEditSources && features.canViewNsfw && isPublic && (
          <BrowsingLevelsInput
            compact
            label="Content levels"
            description={
              forcedBrowsingLevel
                ? 'Only these levels show in this hub.'
                : 'No limit — each viewer’s own settings decide.'
            }
            value={forcedBrowsingLevel}
            allowEmpty
            onChange={setForcedBrowsingLevel}
          />
        )}

        {canEditSources && (
          <>
            <Divider label="Sources" labelPosition="left" />
            {candidates.isFetching ? (
              <Group gap="xs">
                <Loader size="sm" />
                <Text size="sm" c="dimmed">
                  Gathering {template ? gathering[template] : 'sources'}…
                </Text>
              </Group>
            ) : (
              <HubSourceEditor
                value={sources}
                onChange={setSources}
                disabled={upsert.isPending}
                emptyMessage={emptyMessage}
              />
            )}

            {/* The number is the count BEFORE the cap, so this is the shortfall a
                template used to swallow. Deliberately not arithmetic about the cap:
                the gathered list can also be short because a blocked alias was
                dropped, and a sentence claiming otherwise would sometimes be wrong. */}
            {candidateShortfall > 0 && (
              <Alert color="yellow" variant="light" p="xs">
                <Text size="xs">
                  Filled with {sources.length} of your {candidates.data?.total}{' '}
                  {template === 'my-models' ? 'models' : 'follows'} — the rest did not fit. Remove a
                  few to make room for models or tags.
                </Text>
              </Alert>
            )}
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
