import { Anchor, Button, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconCalendar, IconId, IconMapPin, IconPencilMinus } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { openUserProfileEditModal } from '~/components/Dialog/triggers/user-profile-edit';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { ShowcaseSection } from '~/components/Profile/Sections/ShowcaseSection';
import { ProfileSection } from '~/components/Profile/ProfileSection';
import sectionClasses from '~/components/Profile/ProfileSection.module.css';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getUserBannedAtByUsername } from '~/server/services/user-banned-at.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import type { ShowcaseItemSchema } from '~/server/schema/user-profile.schema';
import { formatDate } from '~/utils/date-helpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, features, ssg }) => {
    if (!features?.profileRedesign) return { notFound: true };

    const username = ctx.query.username as string;
    const user = await getUserBannedAtByUsername(username);
    if (user?.bannedAt) return { redirect: { destination: `/user/${username}`, permanent: false } };

    const [profile] = await Promise.all([
      ssg?.userProfile.get.fetch({ username }).catch(() => null),
      ssg?.userProfile.overview.prefetch({ username }),
    ]);
    // The About text is keyed by id, which only the profile read knows.
    if (profile?.id) await ssg?.userProfile.about.prefetch({ userId: profile.id });
  },
});

function hostLabel(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function UserAboutPage() {
  const router = useRouter();
  const username = (router.query.username as string) ?? '';
  const currentUser = useCurrentUser();
  const { data: user, isLoading } = trpc.userProfile.get.useQuery(
    { username },
    { enabled: !!username }
  );
  const { data: aboutData, isLoading: aboutLoading } = trpc.userProfile.about.useQuery(
    { userId: user?.id ?? 0 },
    { enabled: !!user }
  );

  if (!username) return <NotFound />;
  if (isLoading || (user && aboutLoading))
    return (
      <Center mt="md">
        <Loader />
      </Center>
    );
  if (!user) return <NotFound />;

  const isOwner = currentUser?.id === user.id;
  // The sidebar's rule: a muted profile shows none of its own text or links.
  const muted = !!user.muted;
  const { profile } = user;
  const bio = !muted ? profile.bio : null;
  const about = !muted ? aboutData?.about : null;
  const location = !muted ? profile.location : null;
  const links = !muted ? sortDomainLinks(user.links) : [];
  const hasPinned = ((profile.showcaseItems ?? []) as ShowcaseItemSchema[]).length > 0;
  const hasContent = !!bio || !!about || hasPinned || !!location || links.length > 0;

  // The design's right-hand column: labelled facts beside the About text.
  const label = (text: string) => (
    <Text size="xs" fw={700} tt="uppercase" c="dimmed" className="tracking-wider">
      {text}
    </Text>
  );
  const details = (
    <Stack gap="md" className="min-w-0 flex-[1_1_200px]">
      {location && (
        <div>
          {label('Location')}
          <Group gap={6} wrap="nowrap">
            <IconMapPin size={16} className="shrink-0" />
            <Text size="sm">{location}</Text>
          </Group>
        </div>
      )}
      <div>
        {label('Joined')}
        <Group gap={6} wrap="nowrap">
          <IconCalendar size={16} className="shrink-0" />
          <Text size="sm">{formatDate(user.createdAt)}</Text>
        </Group>
      </div>
      {links.length > 0 && (
        <Stack gap={6}>
          {label('Links')}
          {links.map((link, index) => (
            <Group key={index} gap="sm" wrap="nowrap">
              <DomainIcon domain={link.domain} size={20} />
              <Anchor href={link.url} target="_blank" rel="nofollow noreferrer" size="sm" truncate>
                {hostLabel(link.url)}
              </Anchor>
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );

  // Panels, as on the Overview, so a member's card colour and page background apply here too.
  return (
    <div className={sectionClasses.panelLayout}>
      <div className={sectionClasses.panelCell}>
        <div className={sectionClasses.profileSection}>
          <ProfileSection title="About" icon={<IconId />}>
            <div className="flex flex-wrap gap-6">
              <Stack gap="md" className="min-w-0 flex-[2_1_320px]">
                {bio && (
                  <Text style={{ wordWrap: 'break-word', whiteSpace: 'pre-line' }}>{bio}</Text>
                )}
                {about ? (
                  <RenderHtml html={about} />
                ) : (
                  isOwner &&
                  !muted && (
                    <Stack gap="xs" align="flex-start">
                      <Text c="dimmed" size="sm">
                        Tell visitors more about yourself: add an About text in the profile
                        customizer.
                      </Text>
                      <Button
                        size="compact-sm"
                        variant="light"
                        leftSection={<IconPencilMinus size={14} />}
                        onClick={() => openUserProfileEditModal()}
                      >
                        Customize profile
                      </Button>
                    </Stack>
                  )
                )}
                {!hasContent && !isOwner && (
                  <Text c="dimmed">
                    {user.username} hasn&apos;t shared anything about themselves yet.
                  </Text>
                )}
              </Stack>
              {details}
            </div>
          </ProfileSection>
        </div>
      </div>
      {hasPinned && (
        <div className={sectionClasses.panelCell}>
          <ShowcaseSection user={{ ...user, username: user.username as string }} pinned />
        </div>
      )}
    </div>
  );
}

export default Page(UserAboutPage, { getLayout: UserProfileLayout });
