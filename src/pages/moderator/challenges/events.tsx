import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Center,
  ColorSwatch,
  Container,
  Group,
  Loader,
  Menu,
  Modal,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconCalendarEvent, IconDots, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import dayjs from '~/shared/utils/dayjs';
import { useState } from 'react';
import * as z from 'zod';
import { BackButton } from '~/components/BackButton/BackButton';
import { challengeEventTitleColors } from '~/server/schema/challenge.schema';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  Form,
  InputDateTimePicker,
  InputSelect,
  InputSwitch,
  InputText,
  InputTextArea,
  useForm,
} from '~/libs/form';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { formatDate, fromDisplayUTC, toDisplayUTC } from '~/utils/date-helpers';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const titleColorSwatches: Record<string, string> = {
  blue: '#60a5fa',
  purple: '#c084fc',
  red: '#f87171',
  orange: '#fb923c',
  yellow: '#facc15',
  green: '#4ade80',
  pink: '#f472b6',
};

const titleColorOptions = [
  { value: '', label: 'Default' },
  ...challengeEventTitleColors.map((color) => ({
    value: color,
    label: color.charAt(0).toUpperCase() + color.slice(1),
  })),
];

const renderColorOption = ({ option }: { option: { value: string; label: string } }) => (
  <div className="flex items-center gap-2">
    <span>{option.label}</span>
    {option.value && <ColorSwatch size={14} color={titleColorSwatches[option.value]} />}
  </div>
);

const eventFormSchema = z.object({
  id: z.number().optional(),
  title: z.string().min(3, 'Title must be at least 3 characters').max(200),
  description: z.string().optional(),
  titleColor: z.string().optional(),
  startDate: z.date({ error: 'Start date is required' }),
  endDate: z.date({ error: 'End date is required' }),
  active: z.boolean().default(false),
});

type ChallengeEventItem = {
  id: number;
  title: string;
  description: string | null;
  titleColor: string | null;
  startDate: Date;
  endDate: Date;
  active: boolean;
  _count: { challenges: number };
};

function EventFormModal({
  opened,
  onClose,
  event,
}: {
  opened: boolean;
  onClose: () => void;
  event: ChallengeEventItem | undefined;
}) {
  const queryUtils = trpc.useUtils();
  const editingId = event?.id;
  // Default dates (in UTC, shifted for display)
  const defaultStartDate = toDisplayUTC(dayjs.utc().add(1, 'day').startOf('day').toDate());
  const defaultEndDate = toDisplayUTC(dayjs.utc().add(2, 'day').startOf('day').toDate());

  const form = useForm({
    schema: eventFormSchema,
    defaultValues: {
      title: event?.title ?? '',
      description: event?.description ?? '',
      titleColor: event?.titleColor ?? '',
      startDate: event?.startDate ? toDisplayUTC(event.startDate) : defaultStartDate,
      endDate: event?.endDate ? toDisplayUTC(event.endDate) : defaultEndDate,
      active: event?.active ?? false,
    },
  });

  const upsertMutation = trpc.challenge.upsertEvent.useMutation({
    onSuccess: () => {
      queryUtils.challenge.getEvents.invalidate();
      queryUtils.challenge.getActiveEvents.invalidate();
      const action = editingId ? 'updated' : 'created';
      showSuccessNotification({
        message: `Event ${action}.`,
      });
      onClose();
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const handleSubmit = (data: z.infer<typeof eventFormSchema>) => {
    if (data.endDate <= data.startDate) {
      form.setError('endDate', { message: 'End date must be after start date' });
      return;
    }

    const startDate = fromDisplayUTC(data.startDate);
    const endDate = fromDisplayUTC(data.endDate);

    upsertMutation.mutate({
      id: editingId,
      title: data.title,
      description: data.description || undefined,
      titleColor: (data.titleColor as (typeof challengeEventTitleColors)[number]) || undefined,
      startDate,
      endDate,
      active: data.active,
    });
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={editingId ? 'Edit Event' : 'Create Event'}
      size="md"
      centered
    >
      <Form form={form} onSubmit={handleSubmit}>
        <Stack gap="md">
          <InputText
            name="title"
            label="Title"
            placeholder="e.g., CivChan's Be My Valentine Challenge"
            withAsterisk
          />
          <InputTextArea
            name="description"
            label="Description"
            placeholder="Optional description for this event"
            autosize
            minRows={2}
            maxRows={4}
          />
          <InputSelect
            name="titleColor"
            label="Title Color"
            data={titleColorOptions}
            renderOption={renderColorOption}
          />
          <InputDateTimePicker
            name="startDate"
            label="Start Date"
            placeholder="When the event starts"
            valueFormat="lll"
            withAsterisk
          />
          <InputDateTimePicker
            name="endDate"
            label="End Date"
            placeholder="When the event ends"
            valueFormat="lll"
            withAsterisk
          />
          <InputSwitch
            name="active"
            label="Active"
            description="Active events are displayed in the featured challenges section."
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting || upsertMutation.isPending}>
              {editingId ? 'Update' : 'Create'}
            </Button>
          </Group>
        </Stack>
      </Form>
    </Modal>
  );
}

export default function ModeratorChallengeEventsPage() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const queryUtils = trpc.useUtils();
  const [opened, { open, close }] = useDisclosure(false);

  const { data: events, isLoading } = trpc.challenge.getEvents.useQuery({ activeOnly: false });

  const [editingEvent, setEditingEvent] = useState<ChallengeEventItem | undefined>(undefined);

  const deleteMutation = trpc.challenge.deleteEvent.useMutation({
    onSuccess: () => {
      queryUtils.challenge.getEvents.invalidate();
      queryUtils.challenge.getActiveEvents.invalidate();
      showSuccessNotification({ message: 'Event deleted' });
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const handleEdit = (event: ChallengeEventItem) => {
    setEditingEvent(event);
    open();
  };

  const handleDelete = (eventId: number) => {
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Delete Event',
        message: (
          <Text>
            Are you sure? Challenges assigned to this event will be unlinked but not deleted.
          </Text>
        ),
        labels: { cancel: 'Cancel', confirm: 'Delete' },
        confirmProps: { color: 'red' },
        onConfirm: () => deleteMutation.mutateAsync({ id: eventId }),
      },
    });
  };

  const handleCreate = () => {
    setEditingEvent(undefined);
    open();
  };

  if (!features.challengePlatform) return <NotFound />;
  if (!currentUser?.isModerator) {
    return (
      <Center py="xl">
        <Text>Access denied.</Text>
      </Center>
    );
  }

  return (
    <>
      <Meta title="Challenge Events - Moderator" deIndex />

      <EventFormModal
        key={editingEvent?.id ?? 'new'}
        opened={opened}
        onClose={close}
        event={editingEvent}
      />

      <Container size="lg" py="md">
        <Stack gap="md">
          <Group justify="space-between">
            <Group>
              <BackButton url="/moderator/challenges" />
              <IconCalendarEvent size={28} />
              <Title order={2}>Challenge Events</Title>
            </Group>
            <Button leftSection={<IconPlus size={16} />} onClick={handleCreate}>
              Create Event
            </Button>
          </Group>

          {isLoading ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : !events || events.length === 0 ? (
            <NoContent message="No events yet" />
          ) : (
            <Stack gap="sm">
              {events.map((event) => {
                const isActive = event.active && new Date(event.endDate) >= new Date();
                return (
                  <Card key={event.id} withBorder>
                    <Group justify="space-between" align="flex-start">
                      <Stack gap={4} style={{ flex: 1 }}>
                        <Group gap="xs">
                          <Text fw={600}>{event.title}</Text>
                          <Badge color={isActive ? 'green' : 'gray'} size="sm" variant="light">
                            {isActive ? 'Active' : 'Inactive'}
                          </Badge>
                          <Badge color="blue" size="sm" variant="light">
                            {event._count.challenges} challenge
                            {event._count.challenges !== 1 ? 's' : ''}
                          </Badge>
                        </Group>
                        {event.description && (
                          <Text size="sm" c="dimmed">
                            {event.description}
                          </Text>
                        )}
                        <Text size="xs" c="dimmed">
                          {formatDate(event.startDate, 'lll [UTC]', true)} &mdash;{' '}
                          {formatDate(event.endDate, 'lll [UTC]', true)}
                        </Text>
                      </Stack>
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                          <ActionIcon variant="subtle">
                            <IconDots size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item
                            leftSection={<IconPencil size={14} />}
                            onClick={() => handleEdit(event)}
                          >
                            Edit
                          </Menu.Item>
                          <Menu.Item
                            leftSection={<IconTrash size={14} />}
                            color="red"
                            onClick={() => handleDelete(event.id)}
                          >
                            Delete
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    </Group>
                  </Card>
                );
              })}
            </Stack>
          )}
        </Stack>
      </Container>
    </>
  );
}
