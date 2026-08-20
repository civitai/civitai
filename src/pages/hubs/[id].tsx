import { Center, Loader, Text, TextInput } from '@mantine/core';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { HubsLayout } from '~/components/Hubs/HubsLayout';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { Meta } from '~/components/Meta/Meta';
import { ImageSort } from '~/server/common/enums';
import { hubLimits, hubSortSchema } from '~/server/schema/user-hub.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session?.user) return { redirect: { destination: '/login', permanent: false } };
  },
});

export default Page(
  function HubFeedPage() {
    const router = useRouter();
    const hubId = Number(router.query.id);
    const utils = trpc.useUtils();

    const { data: hub, isLoading } = trpc.userHub.getById.useQuery(
      { id: hubId },
      { enabled: Number.isInteger(hubId) }
    );

    const [name, setName] = useState('');
    // Seed once per hub. Initialising once would keep the previous hub's name
    // after switching in the rail; re-seeding on every result would overwrite
    // what the user is typing whenever the query refetches.
    const seededHubId = useRef<number | null>(null);
    useEffect(() => {
      if (hub && seededHubId.current !== hub.id) {
        seededHubId.current = hub.id;
        setName(hub.name);
      }
    }, [hub]);

    const upsert = trpc.userHub.upsert.useMutation({
      onSuccess: async () => {
        await Promise.all([
          utils.userHub.getById.invalidate({ id: hubId }),
          utils.userHub.getAll.invalidate(),
        ]);
      },
      onError: (error) =>
        showErrorNotification({ title: 'Could not save hub', error: new Error(error.message) }),
    });

    if (isLoading)
      return (
        <Center py="xl">
          <Loader />
        </Center>
      );
    if (!hub) return <NotFound />;

    const sort = hubSortSchema.catch(ImageSort.Newest).parse(hub.sort);
    const hasSources = hub.sources.some((s) => s.enabled);

    return (
      <>
        <Meta title={`${hub.name} | Civitai`} deIndex />
        <div className="flex flex-col gap-3 py-3">
          <TextInput
            variant="unstyled"
            aria-label="Hub name"
            value={name}
            maxLength={hubLimits.nameLength}
            disabled={upsert.isPending}
            classNames={{ input: 'text-2xl font-bold' }}
            onChange={(event) => setName(event.currentTarget.value)}
            onBlur={() => {
              const trimmed = name.trim();
              if (!trimmed || trimmed === hub.name) {
                setName(hub.name);
                return;
              }
              upsert.mutate({
                id: hub.id,
                name: trimmed,
                sort,
                period: hub.period,
                sources: hub.sources.map(({ id: _id, ...source }) => source),
              });
            }}
          />

          {!hasSources ? (
            <Text c="dimmed">
              {hub.sources.length === 0
                ? 'This hub is empty. Add a creator or a model to start filling it.'
                : 'Every source in this hub is switched off.'}
            </Text>
          ) : (
            // disableStoreFilters keeps the global image-filter store out of a hub:
            // the hub's own sort and period are what the user configured for it.
            <ImagesInfinite
              showEof
              disableStoreFilters
              filters={{ hubId: hub.id, sort, period: hub.period }}
            />
          )}
        </div>
      </>
    );
  },
  { InnerLayout: ({ children }) => <FeedLayout>{<HubsLayout>{children}</HubsLayout>}</FeedLayout> }
);
