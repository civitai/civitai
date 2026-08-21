import { Button, Card, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconLayoutGrid, IconPlus, IconUsers } from '@tabler/icons-react';
import { Page } from '~/components/AppLayout/Page';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { HubsLayout } from '~/components/Hubs/HubsLayout';
import HubUpsertModal from '~/components/Hubs/HubUpsertModal';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { getUserHubs } from '~/server/services/user-hub.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features }) => {
    if (!features?.userHubs) return { notFound: true };
    if (!session?.user) return { redirect: { destination: '/login', permanent: false } };

    // An entry point, not a page: it lands on a hub. Only someone with no hubs
    // sees this.
    const hubs = await getUserHubs({ userId: session.user.id });
    if (hubs.length) return { redirect: { destination: `/hubs/${hubs[0].id}`, permanent: false } };
  },
});

const points = [
  {
    icon: IconUsers,
    title: 'Pick who fills it',
    text: 'Creators and models you already follow, gathered into one feed.',
  },
  {
    icon: IconLayoutGrid,
    title: 'Keep them apart',
    text: 'One hub per interest, each with its own sort and time range.',
  },
];

export default Page(
  function HubsEmptyPage() {
    return (
      <>
        <Meta title="My Hubs | Civitai" deIndex />
        <MasonryContainer className="min-h-full">
          <div className="py-6">
            <Card withBorder p={0} radius="md" className="overflow-hidden">
              <div className="flex flex-col md:flex-row">
                <div className="flex flex-col gap-4 border-gray-3 bg-gray-0 p-6 md:w-72 md:border-r dark:border-dark-4 dark:bg-dark-6">
                  {points.map(({ icon: Icon, title, text }) => (
                    <div key={title} className="flex gap-3">
                      <ThemeIcon variant="light" size="lg" radius="md">
                        <Icon size={18} />
                      </ThemeIcon>
                      <div>
                        <Text fw={600} size="sm">
                          {title}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {text}
                        </Text>
                      </div>
                    </div>
                  ))}
                </div>

                <Stack gap="md" p="xl" className="min-w-0 flex-1" justify="center">
                  <Title order={2}>You don&apos;t have any hubs yet</Title>
                  <Text c="dimmed">
                    A hub is a feed you compose yourself, from the creators, models and collections
                    you want to keep an eye on. Make one and it shows up in the rail on the left.
                  </Text>
                  <Button
                    size="md"
                    className="self-start"
                    leftSection={<IconPlus size={18} />}
                    onClick={() => dialogStore.trigger({ component: HubUpsertModal })}
                  >
                    Create a hub now
                  </Button>
                </Stack>
              </div>
            </Card>
          </div>
        </MasonryContainer>
      </>
    );
  },
  { InnerLayout: HubsLayout }
);
