import {
  Anchor,
  Badge,
  Button,
  Center,
  Container,
  Group,
  List,
  Loader,
  Modal,
  Pagination,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { ModelStatus } from '~/shared/utils/prisma/enums';
import { IconExternalLink } from '@tabler/icons-react';
import { TRPCClientErrorBase } from '@trpc/client';
import { DefaultErrorShape } from '@trpc/server';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { FlaggedModelsList } from '~/components/Moderation/FlaggedModelsList';

import { unpublishReasons } from '~/server/common/moderation-helpers';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
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
  section: 'unpublished' | 'ai';
};

export default function ModeratorModels() {
  const queryUtils = trpc.useUtils();
  const [state, setState] = useState<State>({
    declineReason: 'Insufficient changes',
    page: 1,
    opened: false,
    selectedModel: null,
    section: 'unpublished',
  });

  const viewingUnpublished = state.section === 'unpublished';

  const { data, isLoading } = trpc.model.getAllPagedSimple.useQuery(
    {
      needsReview: true,
      status: [ModelStatus.UnpublishedViolation, ModelStatus.Published],
      page: state.page,
      limit: 20,
      browsingLevel: allBrowsingLevelsFlag,
    },
    { enabled: viewingUnpublished }
  );

  const { items, ...pagination } = data || {
    items: [],
    totalItems: 0,
    currentPage: 1,
    pageSize: 1,
    totalPages: 1,
  };

  const declineReviewMutation = trpc.model.declineReview.useMutation();
  const declineVersionReviewMutation = trpc.modelVersion.declineReview.useMutation();
  const handleDeclineRequest = async () => {
    if (!state.selectedModel) return;

    const declineMutation = state.selectedModel.modelVersion
      ? declineVersionReviewMutation
      : declineReviewMutation;

    try {
      await declineMutation.mutateAsync({
        id: state.selectedModel.modelVersion
          ? state.selectedModel.modelVersion.id
          : state.selectedModel.id,
        reason: state.declineReason,
      });

      setState((s) => ({ ...s, opened: false, selectedModel: null }));
      await queryUtils.model.getAllPagedSimple.invalidate();
    } catch (e) {
      const error = e as TRPCClientErrorBase<DefaultErrorShape>;
      showErrorNotification({
        title: 'Error declining request',
        error: new Error(error.message),
      });
    }
  };

  const toggleModal = (partialState?: Partial<State>) =>
    setState((s) => ({ ...s, ...partialState, opened: !s.opened }));

  return (
    <>
      <Meta title="Moderator Models" deIndex />
      <Container size="sm">
        <Stack mb="xl">
          <Title order={1}>Models Needing Review</Title>
          <SegmentedControl
            size="sm"
            data={[
              { label: 'Unpublished', value: 'unpublished' },
              { label: 'AI Scanned', value: 'ai' },
            ]}
            onChange={(value) =>
              setState((s) => ({
                ...s,
                section: value as State['section'],
                page: 1,
                opened: false,
                selectedModel: null,
              }))
            }
            value={state.section}
          />
          <Text size="sm" color="dimmed">
            Unpublished models for violating ToS which their owners have requested a review
          </Text>
        </Stack>
        {viewingUnpublished ? (
          <div>
            {isLoading ? (
              <Center p="xl">
                <Loader size="lg" />
              </Center>
            ) : !!data?.items.length ? (
              <Stack>
                <List listStyleType="none" gap="md">
                  {data?.items.map((model) => {
                    const hasVersion = !!model.modelVersion;
                    const unpublishedAt =
                      hasVersion &&
                      model.modelVersion?.meta &&
                      model.modelVersion?.meta?.unpublishedAt
                        ? new Date(model.modelVersion.meta.unpublishedAt)
                        : model.meta && model.meta.unpublishedAt
                        ? new Date(model.meta.unpublishedAt)
                        : null;
                    const unpublishedReason =
                      model.meta?.unpublishedReason ?? model.modelVersion?.meta?.unpublishedReason;
                    const customMessage =
                      model.meta?.customMessage ?? model.modelVersion?.meta?.customMessage;

                    return (
                      <List.Item
                        key={model.id}
                        sx={(theme) => ({
                          padding: theme.spacing.sm,
                          border: `1px solid ${
                            theme.colorScheme === 'dark'
                              ? theme.colors.dark[4]
                              : theme.colors.gray[2]
                          }`,
                          '& > *': { width: '100%' },
                        })}
                      >
                        <Stack gap={8}>
                          <Group justify="space-between" align="flex-start" wrap="nowrap">
                            {hasVersion ? (
                              <Badge color="violet" radius="xl">
                                Model Version
                              </Badge>
                            ) : (
                              <Badge radius="xl">Model</Badge>
                            )}
                            <Button
                              variant="subtle"
                              color="red"
                              onClick={() => toggleModal({ selectedModel: model })}
                              size="compact-xs"
                            >
                              Decline Request
                            </Button>
                          </Group>
                          <Link
                            href={`/models/${model.id}/${slugit(model.name)}${
                              model.modelVersion ? `?modelVersionId=${model.modelVersion.id}` : ''
                            }`}
                            passHref
                            legacyBehavior
                          >
                            <Anchor size="md" target="_blank" lineClamp={1} inline>
                              <div className="flex flex-nowrap gap-1">
                                <IconExternalLink
                                  className="shrink-0 grow-0"
                                  size={16}
                                  stroke={1.5}
                                />
                                {`${model.name}${
                                  model.modelVersion ? ` - ${model.modelVersion.name}` : ''
                                }`}
                              </div>
                            </Anchor>
                          </Link>
                          {unpublishedAt && (
                            <Text size="xs" color="dimmed">
                              Unpublished at: {formatDate(unpublishedAt)}
                            </Text>
                          )}
                          {unpublishedReason && (
                            <Text size="sm">
                              <Text weight={500} size="sm" span>
                                Reason initially unpublished:
                              </Text>{' '}
                              {`${unpublishReasons[unpublishedReason].optionLabel}${
                                customMessage ? ` - ${customMessage}` : ''
                              }`}
                            </Text>
                          )}
                        </Stack>
                      </List.Item>
                    );
                  })}
                </List>
                {pagination.totalPages > 1 && (
                  <Group justify="space-between">
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
                    <Group justify="flex-end">
                      <Button variant="default" onClick={() => toggleModal()}>
                        Cancel
                      </Button>
                      <Button
                        onClick={handleDeclineRequest}
                        loading={declineReviewMutation.isLoading}
                      >
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
          </div>
        ) : (
          <div className="lg:-mx-32">
            <FlaggedModelsList />
          </div>
        )}
      </Container>
    </>
  );
}
