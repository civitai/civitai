import { Button, Text } from '@mantine/core';
import { IconArrowRight, IconExternalLink, IconLayoutGrid } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { useQueryArticles } from '~/components/Article/article.utils';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { useQueryModels } from '~/components/Model/model.utils';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { externalLinkAnchorProps } from '~/components/ExternalLinkWarning/externalLinkAnchorProps';
import { useCurrentDomainHref } from '~/hooks/useCurrentDomainHref';
import { useInternalHosts } from '~/hooks/useInternalHosts';
import { isExternalHref } from '~/utils/external-link';
import type { ProfileSectionProps } from '~/components/Profile/ProfileSection';
import { ProfileSection, ProfileSectionPreview } from '~/components/Profile/ProfileSection';
import classes from '~/components/Profile/ProfileSection.module.css';
import { ShowcaseGrid } from '~/components/Profile/Sections/ShowcaseGrid';
import { ImageSort } from '~/server/common/enums';
import type { ShowcaseSectionSchema } from '~/server/schema/user-profile.schema';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

type CustomShowcaseSectionProps = ProfileSectionProps & { section: ShowcaseSectionSchema };

export const sortByShowcaseOrder = <T extends { id: number }>(rows: T[], ids: number[]) => {
  const position = new Map(ids.map((id, index) => [id, index]));
  return rows
    .filter((row) => position.has(row.id))
    .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
};

// Up to 10 sections per profile: the default (in view) would fetch them all on a first visit.
const useShowcaseInView = (sectionId: string) =>
  useInViewDynamic({ id: `profile-showcase-${sectionId}`, initialInView: false });

export function CustomShowcaseSection({ section, user }: CustomShowcaseSectionProps) {
  if (!section.items.length) return null;
  // Visibility (browsing level, hidden, unpublished) comes from each feed; don't fetch showcased ids by another route.
  switch (section.type) {
    case 'Model':
      return <ModelShowcase section={section} user={user} />;
    case 'Article':
      return <ArticleShowcase section={section} user={user} />;
    case 'Image':
      return <ImageShowcase section={section} user={user} />;
    default:
      return null;
  }
}

function ModelShowcase({ section, user }: CustomShowcaseSectionProps) {
  const [ref, inView] = useShowcaseInView(section.id);
  const { models, isLoading } = useQueryModels(
    {
      ids: section.items,
      username: user.username,
      period: MetricTimeframe.AllTime,
      limit: section.items.length,
    },
    { keepPreviousData: true, enabled: inView }
  );
  const items = useMemo(() => sortByShowcaseOrder(models, section.items), [models, section.items]);

  return (
    <ShowcaseShell
      section={section}
      sectionRef={ref}
      inView={inView}
      isLoading={isLoading}
      count={items.length}
      rows={2}
    >
      {items.map((model) => (
        <ModelCard data={model} key={model.id} />
      ))}
    </ShowcaseShell>
  );
}

function ArticleShowcase({ section, user }: CustomShowcaseSectionProps) {
  const [ref, inView] = useShowcaseInView(section.id);
  const { articles, isLoading } = useQueryArticles(
    {
      ids: section.items,
      username: user.username,
      period: MetricTimeframe.AllTime,
      limit: section.items.length,
    },
    { keepPreviousData: true, enabled: inView }
  );
  const items = useMemo(
    () => sortByShowcaseOrder(articles, section.items),
    [articles, section.items]
  );

  return (
    <ShowcaseShell
      section={section}
      sectionRef={ref}
      inView={inView}
      isLoading={isLoading}
      count={items.length}
      rows={1}
    >
      {items.map((article) => (
        <ArticleCard data={article} aspectRatio="square" key={article.id} />
      ))}
    </ShowcaseShell>
  );
}

function ImageShowcase({ section, user }: CustomShowcaseSectionProps) {
  const [ref, inView] = useShowcaseInView(section.id);
  const { images, isLoading } = useQueryImages(
    {
      ids: section.items,
      userId: user.id,
      // Keeps the owner's drafts and scheduled posts out, as for visitors (the owner still sees
      // their own private or blocked images, which visitors do not).
      publishedOnly: true,
      period: MetricTimeframe.AllTime,
      sort: ImageSort.Newest,
      limit: section.items.length,
      withMeta: false,
      include: ['profilePictures', 'cosmetics'],
      notPublished: false,
    },
    { keepPreviousData: true, enabled: inView }
  );
  const items = useMemo(() => sortByShowcaseOrder(images, section.items), [images, section.items]);

  return (
    <ShowcaseShell
      section={section}
      sectionRef={ref}
      inView={inView}
      isLoading={isLoading}
      count={items.length}
      rows={2}
    >
      <ImagesProvider images={items}>
        {items.map((image) => (
          <ImageCard data={image} key={image.id} hideCreator />
        ))}
      </ImagesProvider>
    </ShowcaseShell>
  );
}

function ShowcaseShell({
  section,
  sectionRef,
  inView,
  isLoading,
  count,
  rows,
  children,
}: {
  section: ShowcaseSectionSchema;
  sectionRef: React.RefObject<HTMLDivElement>;
  inView: boolean;
  isLoading: boolean;
  count: number;
  rows: number;
  children: React.ReactNode;
}) {
  if (inView && !isLoading && !count) return null;

  return (
    <div
      ref={sectionRef}
      className={classes.profileSection}
      style={
        {
          '--count': count,
          '--row-count': rows,
          ...(rows > 1 ? { '--width-grid': '280px' } : {}),
        } as React.CSSProperties
      }
    >
      {inView &&
        (isLoading ? (
          <ProfileSectionPreview rowCount={rows} />
        ) : (
          <ProfileSection
            title={section.title}
            icon={<IconLayoutGrid />}
            action={section.button && <ShowcaseButton {...section.button} />}
          >
            <ShowcaseGrid itemCount={count} rows={rows}>
              {children}
            </ShowcaseGrid>
          </ProfileSection>
        ))}
    </div>
  );
}

function ShowcaseButton({ label, url }: NonNullable<ShowcaseSectionSchema['button']>) {
  const internalHosts = useInternalHosts();
  const toCurrentDomain = useCurrentDomainHref();
  const shared = { h: 34, variant: 'subtle', children: <Text inherit>{label}</Text> } as const;

  // Mirrors AnnouncementCard: internal https links stay in the tab; the rest get the leaving-Civitai warning.
  if (!isExternalHref(url, internalHosts))
    return (
      <Button
        component={Link}
        href={toCurrentDomain(url)}
        rightSection={<IconArrowRight size={16} />}
        {...shared}
      />
    );

  return (
    <Button
      component="a"
      rel="nofollow ugc noopener"
      rightSection={<IconExternalLink size={16} />}
      {...externalLinkAnchorProps(url)}
      {...shared}
    />
  );
}
