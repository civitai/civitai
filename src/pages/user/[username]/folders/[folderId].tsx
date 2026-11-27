import { Button, Center, Chip, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconChevronLeft, IconLock, IconPencil } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { useQueryArticles } from '~/components/Article/article.utils';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { useQueryImages } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { IsClient } from '~/components/IsClient/IsClient';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useQueryModels } from '~/components/Model/model.utils';
import { NextLink } from '~/components/NextLink/NextLink';
import { openFolderEditModal } from '~/components/Profile/Folders/folder-dialogs';
import { folderUrl } from '~/components/Profile/Folders/folder.utils';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { ArticleSort, ImageSort, ModelSort } from '~/server/common/enums';
import { getUserBannedAtByUsername } from '~/server/services/user-banned-at.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CollectionReadConfiguration, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, features, ssg }) => {
    if (!features?.profileRedesign || !features?.profileFolders) return { notFound: true };

    const username = ctx.query.username as string;
    const user = await getUserBannedAtByUsername(username);
    if (user?.bannedAt) return { redirect: { destination: `/user/${username}`, permanent: false } };

    await Promise.all([
      ssg?.userProfile.get.prefetch({ username }),
      ssg?.userProfile.overview.prefetch({ username }),
    ]);
  },
});

type View = 'all' | 'models' | 'images' | 'articles';
const views: { value: View; label: string; count: 'Model' | 'Image' | 'Article' | 'total' }[] = [
  { value: 'all', label: 'All', count: 'total' },
  { value: 'models', label: 'Models', count: 'Model' },
  { value: 'images', label: 'Images & videos', count: 'Image' },
  { value: 'articles', label: 'Articles', count: 'Article' },
];
const PREVIEW = 12;
const grid = 'grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4';

function UserFolderPage() {
  const router = useRouter();
  const username = (router.query.username as string) ?? '';
  const folderId = Number(router.query.folderId);
  const view = (views.find((v) => v.value === router.query.type)?.value ?? 'all') as View;
  const setView = (next: View) =>
    router.replace(
      { query: { ...router.query, type: next === 'all' ? undefined : next } },
      undefined,
      { shallow: true, scroll: false }
    );

  const { data: user, isLoading } = trpc.userProfile.get.useQuery(
    { username },
    { enabled: !!username }
  );
  const {
    data: folder,
    isLoading: folderLoading,
    error,
  } = trpc.profileFolders.get.useQuery(
    { userId: user?.id ?? 0, folderId },
    { enabled: !!user && Number.isInteger(folderId) && folderId > 0, retry: false }
  );

  if (!username || !Number.isInteger(folderId) || folderId <= 0) return <NotFound />;
  if (isLoading || (user && folderLoading && !error))
    return (
      <Center mt="md">
        <Loader />
      </Center>
    );
  if (!user || !folder) return <NotFound />;

  const profileUser = { id: user.id, username: user.username ?? username };

  return (
    <Stack gap="md" py="md">
      <Group gap="sm" wrap="nowrap" align="center">
        <Button
          component={NextLink}
          href={folderUrl(profileUser.username)}
          variant="default"
          radius="xl"
          size="compact-md"
          leftSection={<IconChevronLeft size={16} />}
        >
          All folders
        </Button>
        <Title order={2} lineClamp={1} className="min-w-0 flex-1" c="var(--mantine-color-bright)">
          {folder.name}
        </Title>
        {folder.isOwner && (
          <Button
            variant="default"
            radius="xl"
            leftSection={<IconPencil size={14} />}
            onClick={() => openFolderEditModal({ folder, user: profileUser })}
          >
            Edit folder
          </Button>
        )}
      </Group>
      {(folder.description || folder.read !== CollectionReadConfiguration.Public) && (
        <Group gap="xs">
          {folder.read !== CollectionReadConfiguration.Public && (
            <Text size="xs" c="dimmed" className="flex items-center gap-1">
              <IconLock size={12} /> {folder.read}
            </Text>
          )}
          {folder.description && (
            <Text size="sm" c="dimmed">
              {folder.description}
            </Text>
          )}
        </Group>
      )}

      <Group gap="xs">
        {views
          .filter((v) => v.value === 'all' || folder.counts[v.count] > 0)
          .map((v) => (
            <Chip
              key={v.value}
              checked={view === v.value}
              onChange={() => setView(v.value)}
              variant="outline"
              radius="md"
            >
              {v.label} {folder.counts[v.count]}
            </Chip>
          ))}
      </Group>

      {folder.counts.total === 0 ? (
        <Text c="dimmed" ta="center" py="xl">
          {folder.isOwner
            ? 'This folder is empty. Use Edit folder to add your work.'
            : 'This folder is empty.'}
        </Text>
      ) : (
        <IsClient>
          {view === 'all' ? (
            <AllView folderId={folder.id} counts={folder.counts} onSeeAll={setView} />
          ) : view === 'models' ? (
            <ModelsInfinite
              filters={{
                collectionId: folder.id,
                sort: ModelSort.Newest,
                period: MetricTimeframe.AllTime,
              }}
              disableStoreFilters
            />
          ) : view === 'images' ? (
            <ImagesInfinite
              filters={{
                collectionId: folder.id,
                sort: ImageSort.Newest,
                period: MetricTimeframe.AllTime,
              }}
              collectionId={folder.id}
              disableStoreFilters
            />
          ) : (
            <ArticlesInfinite
              filters={{
                collectionId: folder.id,
                sort: ArticleSort.Newest,
                period: MetricTimeframe.AllTime,
              }}
              disableStoreFilters
            />
          )}
        </IsClient>
      )}
    </Stack>
  );
}

function AllView({
  folderId,
  counts,
  onSeeAll,
}: {
  folderId: number;
  counts: { Model: number; Image: number; Article: number };
  onSeeAll: (view: View) => void;
}) {
  const models = useQueryModels(
    {
      collectionId: folderId,
      sort: ModelSort.Newest,
      period: MetricTimeframe.AllTime,
      limit: PREVIEW,
    },
    { enabled: counts.Model > 0 }
  );
  const images = useQueryImages(
    {
      collectionId: folderId,
      sort: ImageSort.Newest,
      period: MetricTimeframe.AllTime,
      limit: PREVIEW,
      withMeta: false,
      include: ['cosmetics'],
    },
    { enabled: counts.Image > 0 }
  );
  const articles = useQueryArticles(
    {
      collectionId: folderId,
      sort: ArticleSort.Newest,
      period: MetricTimeframe.AllTime,
      limit: PREVIEW,
    },
    { enabled: counts.Article > 0 }
  );

  return (
    <Stack gap="xl">
      {counts.Model > 0 && (
        <TypeGroup
          title="Models"
          count={counts.Model}
          shown={models.models.length}
          loading={models.isLoading}
          onSeeAll={() => onSeeAll('models')}
        >
          {models.models.map((model) => (
            <ModelCard key={model.id} data={model} />
          ))}
        </TypeGroup>
      )}
      {counts.Image > 0 && (
        <TypeGroup
          title="Images & videos"
          count={counts.Image}
          shown={images.images.length}
          loading={images.isLoading}
          onSeeAll={() => onSeeAll('images')}
        >
          <ImagesProvider images={images.images}>
            {images.images.map((image) => (
              <ImageCard key={image.id} data={image} hideCreator />
            ))}
          </ImagesProvider>
        </TypeGroup>
      )}
      {counts.Article > 0 && (
        <TypeGroup
          title="Articles"
          count={counts.Article}
          shown={articles.articles.length}
          loading={articles.isLoading}
          onSeeAll={() => onSeeAll('articles')}
        >
          {articles.articles.map((article) => (
            <ArticleCard key={article.id} data={article} aspectRatio="portrait" />
          ))}
        </TypeGroup>
      )}
    </Stack>
  );
}

function TypeGroup({
  title,
  count,
  shown,
  loading,
  onSeeAll,
  children,
}: {
  title: string;
  count: number;
  shown: number;
  loading: boolean;
  onSeeAll: () => void;
  children: React.ReactNode;
}) {
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text fw={700} size="lg" c="var(--mantine-color-bright)">
          {title}
        </Text>
        {count > PREVIEW && (
          <Button variant="subtle" size="compact-sm" onClick={onSeeAll}>
            See all {count}
          </Button>
        )}
      </Group>
      {loading ? (
        <Center py="md">
          <Loader size="sm" />
        </Center>
      ) : shown === 0 ? (
        // The feeds leave out what this viewer's browsing level or hidden preferences hide.
        <Text size="sm" c="dimmed">
          None of these are available to you with your current browsing settings.
        </Text>
      ) : (
        <div className={grid}>{children}</div>
      )}
    </Stack>
  );
}

export default Page(UserFolderPage, { getLayout: UserProfileLayout });
