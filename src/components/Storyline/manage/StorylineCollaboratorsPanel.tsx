import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { IconRosetteDiscountCheck, IconTrash, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { STORYLINE_MAX_COLLABORATORS } from '~/shared/utils/storyline';

export type StorylineCollaborator = { id: number; username: string | null };

export function StorylineCollaboratorsPanel({
  ownerId,
  collaborators,
  pending,
  canEndorse,
  onAdd,
  onRemove,
  adding,
  removingId,
}: {
  ownerId: number;
  collaborators: StorylineCollaborator[];
  /** Invited, not yet accepted: not shown on the storyline and no rights until they accept. */
  pending: StorylineCollaborator[];
  /** Only the owner endorses: it pre-approves the collaborator's priced continuations. */
  canEndorse: boolean;
  onAdd: (user: StorylineCollaborator) => void;
  onRemove: (userId: number) => void;
  adding?: boolean;
  removingId?: number;
}) {
  const [selected, setSelected] = useState<StorylineCollaborator | null>(null);
  const full = collaborators.length + pending.length >= STORYLINE_MAX_COLLABORATORS;
  const excludedUserIds = [ownerId, ...[...collaborators, ...pending].map((user) => user.id)];

  return (
    <Stack gap="md">
      {canEndorse && (
        <Stack gap={6}>
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <div className="min-w-0 grow">
              {selected ? (
                <Group gap="xs" wrap="nowrap" h={36}>
                  <UserAvatar userId={selected.id} withUsername size="sm" />
                  <LegacyActionIcon
                    size="sm"
                    aria-label="Clear selection"
                    onClick={() => setSelected(null)}
                  >
                    <IconX size={14} />
                  </LegacyActionIcon>
                </Group>
              ) : (
                <QuickSearchDropdown
                  disableInitialSearch
                  supportedIndexes={['users']}
                  showIndexSelect={false}
                  startingIndex="users"
                  dropdownItemLimit={10}
                  placeholder="Invite by username"
                  onItemSelected={(_entity, item) => {
                    const user = item as SearchIndexDataMap['users'][number];
                    setSelected({ id: user.id, username: user.username ?? null });
                  }}
                  filters={excludedUserIds
                    .map((id) => `AND NOT id=${id}`)
                    .join(' ')
                    .slice(4)}
                />
              )}
            </div>
            <Button
              disabled={!selected || full}
              loading={adding}
              onClick={() => {
                if (!selected) return;
                onAdd(selected);
                setSelected(null);
              }}
            >
              Invite
            </Button>
          </Group>
          {full && (
            <Text size="xs" c="dimmed">
              A storyline can have up to {STORYLINE_MAX_COLLABORATORS} endorsed collaborators,
              invitations included.
            </Text>
          )}
          <Text size="xs" c="dimmed">
            They are asked first, and join once they accept.
          </Text>
        </Stack>
      )}

      <Stack gap={2}>
        {collaborators.map((user) => (
          <Group key={user.id} justify="space-between" wrap="nowrap" px={4} py={6}>
            <UserAvatar
              userId={user.id}
              withUsername
              size="sm"
              subText={
                <Group gap={6} wrap="nowrap" component="span">
                  <Badge
                    variant="light"
                    color="teal"
                    size="sm"
                    radius="xl"
                    leftSection={<IconRosetteDiscountCheck size={12} />}
                  >
                    Endorsed
                  </Badge>
                  <Text size="xs" c="dimmed" span>
                    Continuations skip review and are listed after canon
                  </Text>
                </Group>
              }
              subTextForce
            />
            <LegacyActionIcon
              size="sm"
              color="red"
              aria-label={`Remove ${user.username ?? 'collaborator'}`}
              loading={removingId === user.id}
              onClick={() => onRemove(user.id)}
            >
              <IconTrash size={14} />
            </LegacyActionIcon>
          </Group>
        ))}
        {pending.map((user) => (
          <Group key={user.id} justify="space-between" wrap="nowrap" px={4} py={6}>
            <UserAvatar
              userId={user.id}
              withUsername
              size="sm"
              subText={
                <Group gap={6} wrap="nowrap" component="span">
                  <Badge variant="light" color="gray" size="sm" radius="xl">
                    Invited
                  </Badge>
                  <Text size="xs" c="dimmed" span>
                    Waiting for them to accept
                  </Text>
                </Group>
              }
              subTextForce
            />
            {canEndorse && (
              <LegacyActionIcon
                size="sm"
                color="red"
                aria-label={`Cancel ${user.username ?? 'the'} invitation`}
                loading={removingId === user.id}
                onClick={() => onRemove(user.id)}
              >
                <IconX size={14} />
              </LegacyActionIcon>
            )}
          </Group>
        ))}
        {!collaborators.length && !pending.length && (
          <Stack align="center" gap={6} py="lg" className="text-gray-5 dark:text-dark-3">
            <IconRosetteDiscountCheck size={28} stroke={1.5} />
            <Text size="sm" c="dimmed">
              No endorsed collaborators yet.
            </Text>
          </Stack>
        )}
      </Stack>

      <Text size="xs" c="dimmed">
        Removing someone keeps their chapters in the story. It only stops auto-approval and the
        endorsed ordering.
      </Text>
    </Stack>
  );
}
