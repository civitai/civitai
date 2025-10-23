import {
  Badge,
  Button,
  Card,
  Center,
  Flex,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconArticle, IconFilter, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import { ArticleStatus } from '~/shared/utils/prisma/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { unpublishReasons, type UnpublishReason } from '~/server/common/moderation-helpers';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { ArticleGetAllRecord } from '~/server/services/article.service';

const statusOptions = [
  { value: 'all', label: 'All Unpublished' },
  { value: ArticleStatus.Unpublished, label: 'User Unpublished' },
  { value: ArticleStatus.UnpublishedViolation, label: 'ToS Violations' },
];

export default function ModeratorArticlesPage() {
  const currentUser = useCurrentUser();
  const [username, setUsername] = useState('');
  const [debouncedUsername] = useDebouncedValue(username, 500);
  const [status, setStatus] = useState<string>('all');

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.moderator.articles.query.useInfiniteQuery(
      {
        username: debouncedUsername || undefined,
        status: status !== 'all' ? (status as ArticleStatus) : undefined,
      },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        enabled: !!currentUser?.isModerator,
      }
    );

  const articles = data?.pages.flatMap((page) => page.items) ?? [];

  const handleClearFilters = () => {
    setUsername('');
    setStatus('all');
  };

  if (!currentUser?.isModerator) {
    return (
      <Center py="xl">
        <Text>Access denied. You do not have permission to access this page.</Text>
      </Center>
    );
  }

  return (
    <>
      <Meta title="Unpublished Articles - Moderator" deIndex />
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: 'var(--mantine-spacing-md)' }}>
        <Stack gap="md">
          <Card withBorder>
            <Stack gap="md">
              <Group align="center">
                <IconArticle size={32} />
                <div>
                  <Title order={2}>Unpublished Articles</Title>
                  <Text size="sm" c="dimmed">
                    Review and manage unpublished articles
                  </Text>
                </div>
              </Group>
            </Stack>
          </Card>

          <Card withBorder>
            <Stack gap="md">
              <Group align="center">
                <IconFilter size={20} />
                <Text weight={600}>Filters</Text>
              </Group>
              <Group align="end">
                <TextInput
                  label="Username"
                  placeholder="Search by username..."
                  value={username}
                  onChange={(e) => setUsername(e.currentTarget.value)}
                  style={{ flex: 1 }}
                />
                <Select
                  label="Status"
                  data={statusOptions}
                  value={status}
                  onChange={(value) => setStatus(value ?? 'all')}
                  style={{ minWidth: 200 }}
                />
                <Button
                  variant="subtle"
                  leftSection={<IconX size={16} />}
                  onClick={handleClearFilters}
                >
                  Clear All
                </Button>
              </Group>
            </Stack>
          </Card>

          {isLoading ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : articles.length === 0 ? (
            <NoContent message="No unpublished articles found" />
          ) : (
            <Stack gap="md">
              {articles.map((article) => (
                <Card key={article.id} withBorder>
                  <Flex gap="md" align="flex-start">
                    {article.coverImage && (
                      <div
                        style={{
                          width: 120,
                          height: 120,
                          flexShrink: 0,
                          overflow: 'hidden',
                          borderRadius: 8,
                        }}
                      >
                        <EdgeMedia
                          src={article.coverImage.url}
                          width={120}
                          alt={article.title}
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: 'cover',
                          }}
                        />
                      </div>
                    )}
                    <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
                      <Group justify="space-between" wrap="nowrap">
                        <Group gap="xs" style={{ flex: 1, minWidth: 0 }}>
                          <Link href={`/articles/${article.id}`} passHref>
                            <Text
                              weight={600}
                              size="md"
                              style={{ cursor: 'pointer' }}
                              lineClamp={1}
                            >
                              {article.title}
                            </Text>
                          </Link>
                          <Badge
                            color={
                              article.status === ArticleStatus.UnpublishedViolation
                                ? 'red'
                                : 'yellow'
                            }
                            variant="filled"
                            size="sm"
                          >
                            {article.status === ArticleStatus.UnpublishedViolation
                              ? 'ToS Violation'
                              : 'Unpublished'}
                          </Badge>
                        </Group>
                        <ArticleContextMenu article={article as any as ArticleGetAllRecord} />
                      </Group>

                      <UserAvatar user={article.user} size="xs" withUsername linkToProfile />

                      {article.status === ArticleStatus.UnpublishedViolation &&
                        article.metadata?.unpublishedReason && (
                          <Card
                            withBorder
                            p="xs"
                            style={{ backgroundColor: 'var(--mantine-color-red-1)' }}
                          >
                            <Text
                              size="sm"
                              className="font-bold"
                              style={{ color: 'var(--mantine-color-red-9)' }}
                            >
                              Unpublish Reason:
                            </Text>
                            <Text size="sm" style={{ color: 'var(--mantine-color-red-9)' }}>
                              {article.metadata.unpublishedReason !== 'other'
                                ? unpublishReasons[
                                    article.metadata.unpublishedReason as UnpublishReason
                                  ]?.notificationMessage
                                : article.metadata.customMessage}
                            </Text>
                          </Card>
                        )}

                      <Group gap="sm" wrap="wrap">
                        <Text size="xs" c="dimmed">
                          Created: {formatDate(article.createdAt)}
                        </Text>
                        {article.publishedAt && (
                          <Text size="xs" c="dimmed">
                            Published: {formatDate(article.publishedAt)}
                          </Text>
                        )}
                        {article.metadata?.unpublishedAt && (
                          <Text size="xs" c="dimmed">
                            Unpublished: {formatDate(new Date(article.metadata.unpublishedAt))}
                          </Text>
                        )}
                      </Group>
                    </Stack>
                  </Flex>
                </Card>
              ))}

              {hasNextPage && (
                <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetchingNextPage}>
                  <Center py="xl">
                    <Loader />
                  </Center>
                </InViewLoader>
              )}
            </Stack>
          )}
        </Stack>
      </div>
    </>
  );
}
