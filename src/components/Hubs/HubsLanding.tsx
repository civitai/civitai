import { Badge, Button, Card, Loader, Text, ThemeIcon, Title } from '@mantine/core';
import {
  IconLayoutGrid,
  IconLock,
  IconPhoto,
  IconPlus,
  IconUsers,
  IconWorld,
} from '@tabler/icons-react';
import Link from 'next/link';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { describeHubSources, hubUrl } from '~/components/Hubs/hub.utils';
import HubUpsertModal from '~/components/Hubs/HubUpsertModal';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { HubTemplate } from '~/server/schema/user-hub.schema';
import { hubLimits } from '~/server/schema/user-hub.schema';
import type { UserHubSummary } from '~/server/services/user-hub.service';
import { Availability } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

const HUBS_ARTICLE_URL = '/articles/34441';

const templates: {
  template: HubTemplate;
  title: string;
  text: string;
  icon: typeof IconUsers;
  color: string;
}[] = [
  {
    template: 'my-models',
    title: 'Images on my models',
    text: 'Everything people post using your resources, in one feed.',
    icon: IconPhoto,
    color: 'blue',
  },
  {
    template: 'following',
    title: 'Creators I follow',
    text: 'The people you already follow, gathered into a feed you can sort and prune.',
    icon: IconUsers,
    color: 'green',
  },
];

function TemplateCard({
  icon: Icon,
  color,
  title,
  text,
  action,
}: {
  icon: typeof IconUsers;
  color: string;
  title: string;
  text: string;
  action: React.ReactNode;
}) {
  return (
    <Card withBorder radius="md" p="lg" className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <ThemeIcon variant="light" color={color} size="lg" radius="md">
          <Icon size={18} />
        </ThemeIcon>
        <Text fw={700} size="md">
          {title}
        </Text>
      </div>
      <Text size="sm" c="dimmed" className="leading-relaxed">
        {text}
      </Text>
      <div className="mt-auto pt-1">{action}</div>
    </Card>
  );
}

function HubCard({ hub }: { hub: UserHubSummary }) {
  const shared = hub.availability === Availability.Public;

  return (
    <Card
      component={Link}
      href={hubUrl(hub)}
      withBorder
      radius="md"
      p="lg"
      className="flex h-full flex-col gap-2 transition-colors hover:border-blue-5"
    >
      <div className="flex items-start justify-between gap-2">
        <Text fw={700} lineClamp={1}>
          {hub.name}
        </Text>
        <Badge
          size="sm"
          variant="light"
          color={shared ? 'blue' : 'gray'}
          leftSection={shared ? <IconWorld size={12} /> : <IconLock size={12} />}
          className="shrink-0"
        >
          {shared ? 'Shared' : 'Private'}
        </Badge>
      </div>
      <Text size="sm" c="dimmed" lineClamp={1}>
        {describeHubSources(hub.sourceCounts)}
      </Text>
      {hub.description && (
        <Text size="sm" c="dimmed" lineClamp={2} className="leading-snug">
          {hub.description}
        </Text>
      )}
    </Card>
  );
}

function SectionHeading({ title, aside }: { title: string; aside?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <Title order={3} className="text-xl">
        {title}
      </Title>
      {aside}
    </div>
  );
}

export function HubsLanding() {
  const currentUser = useCurrentUser();

  const { data: hubs = [], isLoading } = trpc.userHub.getAll.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const atHubLimit = hubs.length >= hubLimits.hubsPerUser;

  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-xl flex-col gap-3">
          <Title order={1} className="text-4xl font-extrabold tracking-tight">
            Feeds you build yourself
          </Title>
          <Text size="lg" className="leading-relaxed">
            Pick the creators, models and tags you want to keep an eye on. New images show up in
            your hub as they are posted — you never have to add them.
          </Text>
        </div>
        <div className="flex flex-wrap gap-2">
          <LoginRedirect reason="add-to-hub">
            <Button
              size="md"
              leftSection={<IconPlus size={18} />}
              disabled={atHubLimit}
              onClick={() => dialogStore.trigger({ component: HubUpsertModal })}
            >
              New hub
            </Button>
          </LoginRedirect>
          <Button size="md" variant="default" component={Link} href={HUBS_ARTICLE_URL}>
            How hubs work
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHeading
          title="Start with one of these"
          aside={
            <Text size="sm" c="dimmed">
              One click. You can change what is in it afterwards.
            </Text>
          }
        />
        <div className="grid gap-4 md:grid-cols-3">
          {templates.map(({ template, title, text, icon, color }) => (
            <TemplateCard
              key={template}
              icon={icon}
              color={color}
              title={title}
              text={text}
              action={
                <LoginRedirect reason="add-to-hub">
                  <Button
                    variant="light"
                    color={color}
                    disabled={atHubLimit}
                    onClick={() =>
                      dialogStore.trigger({ component: HubUpsertModal, props: { template } })
                    }
                  >
                    Start with these
                  </Button>
                </LoginRedirect>
              }
            />
          ))}

          <TemplateCard
            icon={IconLayoutGrid}
            color="yellow"
            title="Something else"
            text="Name a hub and fill it with the creators, models and tags you choose."
            action={
              <LoginRedirect reason="add-to-hub">
                <Button
                  variant="light"
                  color="yellow"
                  disabled={atHubLimit}
                  onClick={() => dialogStore.trigger({ component: HubUpsertModal })}
                >
                  Start empty
                </Button>
              </LoginRedirect>
            }
          />
        </div>
        {atHubLimit && (
          <Text size="sm" c="dimmed">
            You have {hubLimits.hubsPerUser} hubs, which is the limit. Delete one to make another.
          </Text>
        )}
      </section>

      {currentUser && (
        <section className="flex flex-col gap-4">
          <SectionHeading
            title="My hubs"
            aside={
              !!hubs.length && (
                <Text size="sm" c="dimmed">
                  {hubs.length} of {hubLimits.hubsPerUser}
                </Text>
              )
            }
          />
          {isLoading ? (
            <Loader size="sm" />
          ) : hubs.length ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {hubs.map((hub) => (
                <HubCard key={hub.id} hub={hub} />
              ))}
            </div>
          ) : (
            <Text size="sm" c="dimmed">
              You have not made a hub yet. Pick a starting point above, or make an empty one.
            </Text>
          )}
        </section>
      )}
    </div>
  );
}
