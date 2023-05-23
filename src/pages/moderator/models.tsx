import {
  Anchor,
  Button,
  Center,
  Container,
  Group,
  List,
  Loader,
  Modal,
  Pagination,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { ModelStatus } from '@prisma/client';
import { IconExternalLink } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';

import { unpublishReasons } from '~/server/common/moderation-helpers';
import { ModelGetAllPagedSimple } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

type State = {
  declineReason: string;
  page: number;
  opened: boolean;
  selectedModel: ModelGetAllPagedSimple['items'][number] | null;
};

export default function ModeratorModels() {
  const queryUtils = trpc.useContext();
  const [state, setState] = useState<State>({
    declineReason: 'Insufficient changes',
    page: 1,
    opened: false,
    selectedModel: null,
  });

  const { data, isLoading } = trpc.model.getAllPagedSimple.useQuery({
    needsReview: true,
    status: [ModelStatus.UnpublishedViolation],
    page: state.page,
    limit: 20,
  });

  const { items, ...pagination } = data || {
    items: [],
    totalItems: 0,
    currentPage: 1,
    pageSize: 1,
    totalPages: 1,
  };

  const declineReviewMutation = trpc.model.declineReview.useMutation();
  const handleDeclineRequest = () => {
    if (!state.selectedModel) return;

    declineReviewMutation.mutate(
      { id: state.selectedModel.id, reason: state.declineReason },
      {
        async onSuccess() {
          setState((s) => ({ ...s, opened: false, selectedModel: null }));
          await queryUtils.model.getAllPagedSimple.invalidate();
        },
        onError(error) {
          showErrorNotification({
            title: 'Error declining request',
            error: new Error(error.message),
          });
        },
      }
    );
  };

  const toggleModal = (partialState?: Partial<State>) =>
    setState((s) => ({ ...s, ...partialState, opened: !s.opened }));

  return (
    <Container size="sm">
      <Stack spacing={0} mb="xl">
        <Title order={1}>Models Needing Review</Title>
        <Text size="sm" color="dimmed">
          Unpublished models for violating ToS which their owners have request a review
        </Text>
      </Stack>
      {isLoading ? (
        <Center p="xl">
          <Loader size="lg" />
        </Center>
      ) : !!data?.items.length ? (
        <Stack>
          <List listStyleType="none" spacing="md">
            {data?.items.map((model) => {
              const unpublishedAt =
                model.meta && model.meta.unpublishedAt ? new Date(model.meta.unpublishedAt) : null;
              return (
                <List.Item
                  key={model.id}
                  sx={(theme) => ({
                    padding: theme.spacing.sm,
                    border: `1px solid ${
                      theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
                    }`,
                    '& > *': { width: '100%' },
                  })}
                >
                  <Group position="apart" align="flex-start" noWrap>
                    <Stack spacing={0}>
                      <Link href={`/models/${model.id}/${slugit(model.name)}`} passHref>
                        <Anchor size="md" target="_blank" lineClamp={1}>
                          <IconExternalLink size={16} stroke={1.5} /> {model.name}
                        </Anchor>
                      </Link>
                      {unpublishedAt && (
                        <Text size="xs" color="dimmed">
                          Unpublished at: {formatDate(unpublishedAt)}
                        </Text>
                      )}
                      {model.meta && model.meta.unpublishedReason && (
                        <Text size="sm">
                          <Text weight={500} size="sm" span>
                            Reason initially unpublished:
                          </Text>{' '}
                          {`${unpublishReasons[model.meta.unpublishedReason].optionLabel}${
                            model.meta.customMessage ? ` - ${model.meta.customMessage}` : ''
                          }`}
                        </Text>
                      )}
                    </Stack>
                    <Button
                      variant="subtle"
                      size="xs"
                      color="red"
                      onClick={() => toggleModal({ selectedModel: model })}
                      compact
                    >
                      Decline Request
                    </Button>
                  </Group>
                </List.Item>
              );
            })}
          </List>
          {pagination.totalPages > 1 && (
            <Group position="apart">
              <Text>Total {pagination.totalItems} items</Text>
              <Pagination
                page={state.page}
                onChange={(page) => setState((s) => ({ ...s, page }))}
                total={pagination.totalPages}
              />
            </Group>
          )}
          <Modal opened={state.opened} onClose={() => toggleModal()} title="Decline Request">
            <Stack>
              <Textarea
                name="declineReason"
                description="Reason for declining request"
                minRows={2}
                placeholder="i.e.: Insufficient changes"
                value={state.declineReason}
                onChange={(e) => setState((s) => ({ ...s, declineReason: e.target.value }))}
              />
              <Group position="right">
                <Button variant="default" onClick={() => toggleModal()}>
                  Cancel
                </Button>
                <Button onClick={handleDeclineRequest} loading={declineReviewMutation.isLoading}>
                  Send
                </Button>
              </Group>
            </Stack>
          </Modal>
        </Stack>
      ) : (
        <Paper p="xl" withBorder>
          <Center>
            <Text size="md" color="dimmed">
              There are no models that need review
            </Text>
          </Center>
        </Paper>
      )}
    </Container>
  );
}
