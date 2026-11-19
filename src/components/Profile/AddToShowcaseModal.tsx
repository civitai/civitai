import { Badge, Group, Modal, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { ShowcaseEntityType } from '~/components/Profile/AddToShowcaseMenuItem';
import { addsToTopShowcase, useAddToTopShowcase } from '~/components/Profile/AddToShowcaseMenuItem';
import { showcaseSectionLimits } from '~/server/schema/user-profile.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Props = { entityType: ShowcaseEntityType; entityId: number; username: string };

type Row = {
  key: string;
  title: string;
  count?: string;
  state?: 'Added' | 'Full';
  /** Resolves whether it was added. */
  onPick: () => Promise<boolean>;
};

export default function AddToShowcaseModal({ entityType, entityId, username }: Props) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const { data: user } = trpc.userProfile.get.useQuery({ username });
  const topShowcase = useAddToTopShowcase(entityType);
  const addToSection = trpc.userProfile.addToShowcaseSection.useMutation({
    onSuccess: async ({ sections }) => {
      utils.userProfile.get.setData({ username }, (old) =>
        old ? { ...old, profile: { ...old.profile, showcaseSections: sections } } : old
      );
      // The profile page may have cached it under another spelling of the username.
      await utils.userProfile.get.invalidate();
    },
  });
  const isPending = topShowcase.isPending || addToSection.isPending;

  const showcaseItems = user?.profile?.showcaseItems ?? [];
  const rows: Row[] = [
    ...(addsToTopShowcase(entityType)
      ? [
          {
            key: 'top',
            title: 'Showcase (top of profile)',
            state: showcaseItems.some(
              (item) => item.entityType === entityType && item.entityId === entityId
            )
              ? ('Added' as const)
              : undefined,
            onPick: () => topShowcase.add(entityId),
          },
        ]
      : []),
    ...(user?.profile?.showcaseSections ?? [])
      .filter((section) => section.type === entityType)
      .map(
        (section): Row => ({
          key: section.id,
          title: section.title,
          count: `${section.items.length}/${showcaseSectionLimits.items}`,
          state: section.items.includes(entityId)
            ? 'Added'
            : section.items.length >= showcaseSectionLimits.items
            ? 'Full'
            : undefined,
          onPick: () =>
            addToSection
              .mutateAsync({ sectionId: section.id, entityType, entityId })
              .then(() => {
                showSuccessNotification({ message: `Added to ${section.title}` });
                return true;
              })
              .catch((error) => {
                showErrorNotification({
                  title: 'Unable to add to showcase',
                  error: new Error(error.message),
                });
                return false;
              }),
        })
      ),
  ];

  return (
    <Modal {...dialog} title="Add to showcase" size="sm">
      <Stack gap="xs">
        {rows.map((row) => (
          <UnstyledButton
            key={row.key}
            className="rounded-md border border-solid border-gray-3 px-3 py-2 enabled:hover:bg-gray-0 disabled:opacity-50 dark:border-dark-4 dark:enabled:hover:bg-dark-5"
            disabled={!!row.state || isPending}
            onClick={async () => {
              if (await row.onPick()) dialog.onClose();
            }}
          >
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" lineClamp={1}>
                {row.title}
              </Text>
              <Group gap={6} wrap="nowrap">
                {row.count && (
                  <Text size="xs" c="dimmed">
                    {row.count}
                  </Text>
                )}
                {row.state && (
                  <Badge size="sm" variant="light" color={row.state === 'Full' ? 'gray' : 'green'}>
                    {row.state}
                  </Badge>
                )}
              </Group>
            </Group>
          </UnstyledButton>
        ))}
      </Stack>
    </Modal>
  );
}
