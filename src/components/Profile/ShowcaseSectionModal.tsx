import { Button, Group, Modal, SegmentedControl, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ShowcaseItemsInput } from '~/components/Profile/ShowcaseItemsInput';
import type { SearchIndexKey } from '~/components/Search/search.types';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type {
  ShowcaseSectionSchema,
  ShowcaseSectionType,
} from '~/server/schema/user-profile.schema';
import {
  isShowcaseButtonUrl,
  showcaseSectionLimits,
  showcaseSectionSchema,
} from '~/server/schema/user-profile.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const typeIndex: Record<ShowcaseSectionType, SearchIndexKey> = {
  Model: 'models',
  Article: 'articles',
  Image: 'images',
};
const typeOptions = [
  { value: 'Model', label: 'Models' },
  { value: 'Article', label: 'Articles' },
  { value: 'Image', label: 'Images' },
];

type Props = {
  sections: ShowcaseSectionSchema[];
  /** The section to edit; absent to create one. */
  sectionId?: string;
};

export default function ShowcaseSectionModal({ sections, sectionId }: Props) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const existing = sections.find((s) => s.id === sectionId);
  const [id] = useState(() => existing?.id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 12));

  const [type, setType] = useState<ShowcaseSectionType>(existing?.type ?? 'Model');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [items, setItems] = useState<number[]>(existing?.items ?? []);
  const [buttonLabel, setButtonLabel] = useState(existing?.button?.label ?? '');
  const [buttonUrl, setButtonUrl] = useState(existing?.button?.url ?? '');

  const { mutate, isPending } = trpc.userProfile.setShowcaseSections.useMutation({
    onSuccess: (showcaseSections) => {
      if (currentUser)
        utils.userProfile.get.setData({ username: currentUser.username }, (old) =>
          old ? { ...old, profile: { ...old.profile, showcaseSections } } : old
        );
      dialog.onClose();
    },
    onError: (error) =>
      showErrorNotification({
        title: 'Could not save the section',
        error: new Error(error.message),
      }),
  });

  const hasButton = !!buttonLabel.trim() || !!buttonUrl.trim();
  const buttonUrlError =
    buttonUrl.trim() && !isShowcaseButtonUrl(buttonUrl.trim())
      ? 'Use a civitai.com path like /models/123 or a link starting with https://'
      : undefined;
  const section = {
    id,
    type,
    title,
    items,
    button: hasButton ? { label: buttonLabel, url: buttonUrl } : undefined,
  };
  const valid = showcaseSectionSchema.safeParse(section).success;

  const handleSave = () =>
    mutate({
      sections: existing
        ? sections.map((s) => (s.id === existing.id ? section : s))
        : [...sections, section],
    });
  const handleDelete = () =>
    existing && mutate({ sections: sections.filter((s) => s.id !== existing.id) });

  return (
    <Modal
      {...dialog}
      title={existing ? 'Edit showcase section' : 'New showcase section'}
      size="lg"
    >
      <Stack>
        <SegmentedControl
          data={typeOptions}
          value={type}
          onChange={(value) => {
            setType(value as ShowcaseSectionType);
            setItems([]);
          }}
          disabled={!!existing}
        />
        <TextInput
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          maxLength={showcaseSectionLimits.title}
          required
        />
        <ShowcaseItemsInput
          key={type}
          label="Items"
          description={`Pick up to ${showcaseSectionLimits.items} of your own, then drag to order them.`}
          username={currentUser?.username}
          supportedIndexes={[typeIndex[type]]}
          limit={showcaseSectionLimits.items}
          value={items.map((entityId) => ({ entityType: type, entityId }))}
          onChange={(value) => setItems(value.map((item) => item.entityId))}
        />
        <Group grow align="flex-start">
          <TextInput
            label="Button label"
            description="Optional, shown where “View all” usually sits"
            value={buttonLabel}
            onChange={(e) => setButtonLabel(e.currentTarget.value)}
            maxLength={showcaseSectionLimits.buttonLabel}
            error={hasButton && !buttonLabel.trim() ? 'Add a label for the link' : undefined}
          />
          <TextInput
            label="Button link"
            description="A civitai.com path or an https:// link"
            value={buttonUrl}
            onChange={(e) => setButtonUrl(e.currentTarget.value)}
            error={buttonUrlError ?? (hasButton && !buttonUrl.trim() ? 'Add a link' : undefined)}
          />
        </Group>
        {!items.length && (
          <Text size="xs" c="dimmed">
            A section with no items is not shown on your profile.
          </Text>
        )}
        <Group justify="space-between">
          {existing ? (
            <Button color="red" variant="subtle" onClick={handleDelete} loading={isPending}>
              Delete section
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={handleSave} disabled={!valid} loading={isPending}>
            Save section
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
