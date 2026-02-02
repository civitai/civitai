import { ActionIcon, Container, Select } from '@mantine/core';
import {
  IconArrowLeft,
  IconBook,
  IconChevronLeft,
  IconChevronRight,
  IconPhoto,
  IconPhotoOff,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo, useRef } from 'react';

import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';
import styles from '../Comics.module.scss';

function PublicComicReader() {
  const router = useRouter();
  const { id, chapter } = router.query;
  const projectId = id as string;
  const chapterIdx = chapter != null ? Number(chapter) : null;

  const { data: project, isLoading } = trpc.comics.getPublicProjectForReader.useQuery(
    { id: projectId },
    { enabled: !!projectId }
  );

  if (isLoading) {
    return (
      <div className={styles.loadingCenter} style={{ minHeight: '60vh' }}>
        <div className={styles.spinner} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className={styles.notFound}>
        <IconPhotoOff size={48} />
        <p>Comic not found</p>
        <Link href="/comics/browse" className={styles.notFoundLink}>
          <IconArrowLeft size={16} />
          Browse Comics
        </Link>
      </div>
    );
  }

  if (chapterIdx == null) {
    return <ComicOverview project={project} />;
  }

  return <ChapterReader project={project} chapterIdx={chapterIdx} />;
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Project = RouterOutput['comics']['getPublicProjectForReader'];

// ─── Overview / Landing Page ─────────────────────────────────────────────────

function ComicOverview({ project }: { project: Project }) {
  const totalPanels = project.chapters.reduce((sum, ch) => sum + ch.panels.length, 0);
  const coverUrl =
    project.coverImageUrl ??
    project.chapters.flatMap((ch) => ch.panels).find((p) => p.imageUrl)?.imageUrl ??
    null;

  return (
    <>
      <Meta title={`${project.name} - Civitai Comics`} />

      <div className={styles.overviewRoot}>
        {/* Hero image */}
        <div className={styles.overviewHero}>
          {coverUrl ? (
            <>
              <img
                src={getEdgeUrl(coverUrl, { width: 1200 })}
                alt={project.name}
                className={styles.overviewHeroImage}
              />
              <div className={styles.overviewHeroGradient} />
            </>
          ) : (
            <div className={styles.overviewHeroEmpty}>
              <IconPhoto size={64} />
            </div>
          )}
        </div>

        {/* Content overlapping hero */}
        <Container size="sm" className={styles.overviewContent}>
          {/* Back link */}
          <div className={styles.overviewMeta}>
            <Link href="/comics/browse" className={styles.overviewBackBtn}>
              <IconArrowLeft size={16} />
              Browse
            </Link>
          </div>

          {/* Title */}
          <h1 className={styles.overviewTitle}>{project.name}</h1>

          {/* Creator */}
          <div className={styles.overviewCreatorRow}>
            <UserAvatarSimple {...project.user} />
          </div>

          {/* Description */}
          {project.description && (
            <p className={styles.overviewDescription}>{project.description}</p>
          )}

          {/* Stats */}
          <div className={styles.overviewStats}>
            <span className={styles.overviewStatPill}>
              <span className={styles.overviewStatDot} />
              {project.chapters.length}{' '}
              {project.chapters.length === 1 ? 'chapter' : 'chapters'}
            </span>
            <span className={styles.overviewStatPill}>
              <span className={styles.overviewStatDot} />
              {totalPanels} {totalPanels === 1 ? 'panel' : 'panels'}
            </span>
          </div>

          {/* CTA */}
          <Link
            href={`/comics/read/${project.id}?chapter=0`}
            className={styles.ctaBtn}
          >
            <IconBook size={20} />
            Start Reading
          </Link>

          {/* Chapter list */}
          <div className={styles.chapterSection}>
            <p className={styles.chapterSectionTitle}>Chapters</p>
            <div className="flex flex-col gap-2">
              {project.chapters.map((ch, i) => {
                const thumbUrl = ch.panels[0]?.imageUrl ?? null;
                return (
                  <Link
                    key={ch.id}
                    href={`/comics/read/${project.id}?chapter=${i}`}
                    className={styles.chapterListItem}
                  >
                    <span className={styles.chapterNumber}>{i + 1}</span>
                    <div className={styles.chapterThumb}>
                      {thumbUrl ? (
                        <img
                          src={getEdgeUrl(thumbUrl, { width: 120 })}
                          alt={ch.name}
                        />
                      ) : (
                        <div
                          className={`${styles.chapterThumb} ${styles.chapterThumbEmpty}`}
                        >
                          <IconPhoto size={18} />
                        </div>
                      )}
                    </div>
                    <div className={styles.chapterInfo}>
                      <p className={styles.chapterName}>{ch.name}</p>
                      <p className={styles.chapterPanelCount}>
                        {ch.panels.length} {ch.panels.length === 1 ? 'panel' : 'panels'}
                      </p>
                    </div>
                    <IconChevronRight size={18} className={styles.chapterArrow} />
                  </Link>
                );
              })}
            </div>
          </div>
        </Container>
      </div>
    </>
  );
}

// ─── Chapter Reader ──────────────────────────────────────────────────────────

function ChapterReader({ project, chapterIdx }: { project: Project; chapterIdx: number }) {
  const router = useRouter();
  const chapters = project.chapters;
  const safeIdx = Math.max(0, Math.min(chapterIdx, chapters.length - 1));
  const activeChapter = chapters[safeIdx];
  const panels = activeChapter?.panels ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);

  const chapterOptions = useMemo(
    () =>
      chapters.map((ch, i) => ({
        value: String(i),
        label: `${ch.name} (${ch.panels.length})`,
      })),
    [chapters]
  );

  const hasPrev = safeIdx > 0;
  const hasNext = safeIdx < chapters.length - 1;

  const goToChapter = (idx: number) => {
    scrollRef.current?.scrollTo({ top: 0 });
    void router.replace(`/comics/read/${project.id}?chapter=${idx}`, undefined, {
      shallow: true,
    });
  };

  return (
    <>
      <Meta
        title={`${activeChapter?.name ?? 'Chapter'} - ${project.name} - Civitai Comics`}
      />

      <div ref={scrollRef} className={styles.readerRoot}>
        {/* Sticky header */}
        <div className={styles.readerHeader}>
          <Container size="sm">
            <div className={styles.readerHeaderInner}>
              <div className={styles.readerHeaderLeft}>
                <ActionIcon
                  variant="subtle"
                  component={Link}
                  href={`/comics/read/${project.id}`}
                >
                  <IconArrowLeft size={20} />
                </ActionIcon>
                <div className={styles.readerTitleGroup}>
                  <p className={styles.readerTitle}>{project.name}</p>
                  {project.user.username && (
                    <Link
                      href={`/user/${project.user.username}`}
                      className={styles.readerCreator}
                    >
                      by {project.user.username}
                    </Link>
                  )}
                </div>
              </div>

              <div className={styles.readerChapterNav}>
                <ActionIcon
                  variant="subtle"
                  disabled={!hasPrev}
                  onClick={() => goToChapter(safeIdx - 1)}
                >
                  <IconChevronLeft size={18} />
                </ActionIcon>
                <Select
                  size="xs"
                  data={chapterOptions}
                  value={String(safeIdx)}
                  onChange={(v) => v !== null && goToChapter(Number(v))}
                  styles={{ input: { width: 160 } }}
                  allowDeselect={false}
                />
                <ActionIcon
                  variant="subtle"
                  disabled={!hasNext}
                  onClick={() => goToChapter(safeIdx + 1)}
                >
                  <IconChevronRight size={18} />
                </ActionIcon>
              </div>
            </div>
          </Container>
        </div>

        {/* Panel content */}
        <Container size="sm" p={0}>
          {panels.length === 0 ? (
            <div className={styles.readerEmpty}>
              <IconPhotoOff size={48} />
              <p>No panels in this chapter</p>
              <Link
                href={`/comics/read/${project.id}`}
                className={styles.notFoundLink}
              >
                <IconArrowLeft size={16} />
                Back to overview
              </Link>
            </div>
          ) : (
            <div className={styles.readerPanels}>
              {panels.map((panel) => (
                <img
                  key={panel.id}
                  src={panel.imageUrl!}
                  alt={panel.prompt}
                  loading="lazy"
                  className={styles.readerPanel}
                />
              ))}
            </div>
          )}
        </Container>

        {/* Bottom nav */}
        {panels.length > 0 && (
          <Container size="sm">
            <div className={styles.readerBottomNav}>
              <button
                className={styles.readerNavBtn}
                disabled={!hasPrev}
                onClick={() => goToChapter(safeIdx - 1)}
              >
                <IconChevronLeft size={16} />
                Previous Chapter
              </button>
              <button
                className={styles.readerNavBtn}
                disabled={!hasNext}
                onClick={() => goToChapter(safeIdx + 1)}
              >
                Next Chapter
                <IconChevronRight size={16} />
              </button>
            </div>
          </Container>
        )}
      </div>
    </>
  );
}

export default Page(PublicComicReader, { header: null });
