import { ActionIcon, Container, Select, Textarea, Button } from '@mantine/core';
import {
  IconArrowLeft,
  IconBell,
  IconBellOff,
  IconBook,
  IconChevronLeft,
  IconChevronRight,
  IconPhoto,
  IconPhotoOff,
  IconSend,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ComicEngagementType } from '~/shared/utils/prisma/enums';
import { slugit } from '~/utils/string-helpers';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';
import styles from '../Comics.module.scss';

function PublicComicReader() {
  const router = useRouter();
  const { id, slug } = router.query as { id: string; slug?: string[] };
  const projectId = Number(id);

  // /comics/42              → overview
  // /comics/42/my-comic     → overview (slug = ["my-comic"])
  // /comics/42/my-comic/2/… → chapter reader (slug[1] = "2", 1-indexed)
  const isChapterView = slug && slug.length >= 2;
  const chapterUrlPos = isChapterView ? Number(slug[1]) : null; // 1-indexed
  const chapterDbPos =
    chapterUrlPos != null && Number.isFinite(chapterUrlPos) ? chapterUrlPos - 1 : null; // 0-indexed

  const {
    data: project,
    isLoading,
    isError,
  } = trpc.comics.getPublicProjectForReader.useQuery(
    { id: projectId },
    { enabled: !isNaN(projectId) && projectId > 0 }
  );

  if (isLoading) {
    return (
      <div className={styles.loadingCenter} style={{ minHeight: '60vh' }}>
        <div className={styles.spinner} />
      </div>
    );
  }

  if (isError || !project) {
    return (
      <div className={styles.notFound}>
        <IconPhotoOff size={48} />
        <p>{isError ? 'Failed to load comic' : 'Comic not found'}</p>
        <Link href="/comics" className={styles.notFoundLink}>
          <IconArrowLeft size={16} />
          Browse Comics
        </Link>
      </div>
    );
  }

  if (chapterDbPos == null) {
    return <ComicOverview project={project} />;
  }

  return <ChapterReader project={project} chapterDbPos={chapterDbPos} />;
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Project = RouterOutput['comics']['getPublicProjectForReader'];

// ─── Overview / Landing Page ─────────────────────────────────────────────────

function ComicOverview({ project }: { project: Project }) {
  const currentUser = useCurrentUser();
  const totalPanels = project.chapters.reduce((sum, ch) => sum + ch.panels.length, 0);
  const coverUrl =
    project.coverImage?.url ??
    project.chapters.flatMap((ch) => ch.panels).find((p) => p.imageUrl)?.imageUrl ??
    null;

  // Read status for chapters
  const { data: readPositions } = trpc.comics.getChapterReadStatus.useQuery(
    { projectId: project.id },
    { enabled: !!currentUser }
  );

  // Engagement (follow)
  const { data: engagement } = trpc.comics.getComicEngagement.useQuery(
    { projectId: project.id },
    { enabled: !!currentUser }
  );
  const utils = trpc.useUtils();
  const toggleEngagement = trpc.comics.toggleComicEngagement.useMutation({
    onSuccess: () => {
      utils.comics.getComicEngagement.invalidate({ projectId: project.id });
    },
  });
  const isFollowing = engagement === ComicEngagementType.Notify;

  const projectSlug = slugit(project.name);

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
            <Link href="/comics" className={styles.overviewBackBtn}>
              <IconArrowLeft size={16} />
              Browse
            </Link>

            {currentUser && (
              <ActionIcon
                variant={isFollowing ? 'filled' : 'subtle'}
                color={isFollowing ? 'blue' : 'gray'}
                onClick={() =>
                  toggleEngagement.mutate({
                    projectId: project.id,
                    type: ComicEngagementType.Notify,
                  })
                }
                loading={toggleEngagement.isPending}
              >
                {isFollowing ? <IconBellOff size={18} /> : <IconBell size={18} />}
              </ActionIcon>
            )}
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
              {project.chapters.length} {project.chapters.length === 1 ? 'chapter' : 'chapters'}
            </span>
            <span className={styles.overviewStatPill}>
              <span className={styles.overviewStatDot} />
              {totalPanels} {totalPanels === 1 ? 'panel' : 'panels'}
            </span>
          </div>

          {/* CTA */}
          {project.chapters.length > 0 && (
            <Link
              href={`/comics/${project.id}/${projectSlug}/${
                (project.chapters.findIndex((ch) => ch.panels.length > 0) ?? 0) + 1
              }/${slugit(project.chapters.find((ch) => ch.panels.length > 0)?.name ?? 'chapter')}`}
              className={styles.ctaBtn}
            >
              <IconBook size={20} />
              Start Reading
            </Link>
          )}

          {/* Chapter list */}
          <div className={styles.chapterSection}>
            <p className={styles.chapterSectionTitle}>Chapters</p>
            <div className="flex flex-col gap-2">
              {project.chapters.map((ch) => {
                const thumbUrl = ch.panels[0]?.imageUrl ?? null;
                const isRead = readPositions ? readPositions.includes(ch.position) : false;

                return (
                  <Link
                    key={`${ch.projectId}-${ch.position}`}
                    href={`/comics/${project.id}/${projectSlug}/${ch.position + 1}/${slugit(
                      ch.name
                    )}`}
                    className={styles.chapterListItem}
                    style={{ fontWeight: isRead ? 'normal' : 'bold' }}
                  >
                    <span className={styles.chapterNumber}>{ch.position + 1}</span>
                    <div className={styles.chapterThumb}>
                      {thumbUrl ? (
                        <img src={getEdgeUrl(thumbUrl, { width: 120 })} alt={ch.name} />
                      ) : (
                        <div className={`${styles.chapterThumb} ${styles.chapterThumbEmpty}`}>
                          <IconPhoto size={18} />
                        </div>
                      )}
                    </div>
                    <div className={styles.chapterInfo}>
                      <p className={styles.chapterName}>
                        {!isRead && (
                          <span className="inline-block w-2 h-2 rounded-full bg-blue-500 mr-1.5" />
                        )}
                        {ch.name}
                      </p>
                      {ch.publishedAt && (
                        <p className={styles.chapterPanelCount}>
                          {formatRelativeDate(ch.publishedAt)}
                        </p>
                      )}
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

function ChapterReader({ project, chapterDbPos }: { project: Project; chapterDbPos: number }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const chapters = project.chapters;
  const chapterIdx = chapters.findIndex((ch) => ch.position === chapterDbPos);
  const safeIdx = chapterIdx >= 0 ? chapterIdx : 0;
  const activeChapter = chapters[safeIdx];
  const panels = activeChapter?.panels ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);

  const projectSlug = slugit(project.name);

  const chapterOptions = useMemo(
    () =>
      chapters.map((ch, i) => ({
        value: String(i),
        label: `Ch. ${ch.position + 1}: ${ch.name}`,
      })),
    [chapters]
  );

  const hasPrev = safeIdx > 0;
  const hasNext = safeIdx < chapters.length - 1;

  const goToChapter = (idx: number) => {
    const ch = chapters[idx];
    if (!ch) return;
    scrollRef.current?.scrollTo({ top: 0 });
    void router.replace(
      `/comics/${project.id}/${projectSlug}/${ch.position + 1}/${slugit(ch.name)}`,
      undefined,
      { shallow: true }
    );
  };

  // Auto-mark chapter as read
  const markRead = trpc.comics.markChapterRead.useMutation();
  useEffect(() => {
    if (currentUser && activeChapter) {
      markRead.mutate({ projectId: project.id, chapterPosition: activeChapter.position });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChapter?.position, currentUser?.id]);

  // Hide header on scroll down, show on scroll up
  const handleScroll = useCallback(() => {
    if (!headerRef.current) return;
    const el = scrollRef.current ?? document.documentElement;
    const scrollTop = el.scrollTop ?? window.scrollY;
    if (scrollTop > lastScrollTop.current && scrollTop > 80) {
      headerRef.current.style.transform = 'translateY(-100%)';
    } else {
      headerRef.current.style.transform = 'translateY(0)';
    }
    lastScrollTop.current = scrollTop;
  }, []);

  useEffect(() => {
    const el = scrollRef.current ?? window;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Prev/next navigation component (shared between top and bottom)
  const ChapterNav = () => (
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
  );

  return (
    <>
      <Meta title={`${activeChapter?.name ?? 'Chapter'} - ${project.name} - Civitai Comics`} />

      <div ref={scrollRef} className={styles.readerRoot}>
        {/* Sticky header — hides on scroll down */}
        <div
          ref={headerRef}
          className={styles.readerHeader}
          style={{ transition: 'transform 0.2s ease' }}
        >
          <Container size="sm">
            <div className={styles.readerHeaderInner}>
              <div className={styles.readerHeaderLeft}>
                <ActionIcon
                  variant="subtle"
                  component={Link}
                  href={`/comics/${project.id}/${projectSlug}`}
                >
                  <IconArrowLeft size={20} />
                </ActionIcon>
                <div className={styles.readerTitleGroup}>
                  <p className={styles.readerTitle}>{project.name}</p>
                  {project.user.username && (
                    <Link
                      href={`/user/${project.user.username}/comics`}
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

        {/* Top prev/next nav */}
        {panels.length > 0 && (
          <Container size="sm">
            <ChapterNav />
          </Container>
        )}

        {/* Panel content */}
        <Container size="sm" p={0}>
          {panels.length === 0 ? (
            <div className={styles.readerEmpty}>
              <IconPhotoOff size={48} />
              <p>No panels in this chapter</p>
              <Link href={`/comics/${project.id}/${projectSlug}`} className={styles.notFoundLink}>
                <IconArrowLeft size={16} />
                Back to overview
              </Link>
            </div>
          ) : (
            <div className={styles.readerPanels}>
              {panels.map((panel) =>
                panel.imageUrl ? (
                  <img
                    key={panel.id}
                    src={panel.imageUrl}
                    alt={panel.prompt}
                    loading="lazy"
                    className={styles.readerPanel}
                  />
                ) : null
              )}
            </div>
          )}
        </Container>

        {/* Bottom nav */}
        {panels.length > 0 && (
          <Container size="sm">
            <ChapterNav />
          </Container>
        )}

        {/* Comments section */}
        {activeChapter && (
          <Container size="sm" py="xl">
            <ChapterComments projectId={project.id} chapterPosition={activeChapter.position} />
          </Container>
        )}
      </div>
    </>
  );
}

// ─── Comments ────────────────────────────────────────────────────────────────

function ChapterComments({
  projectId,
  chapterPosition,
}: {
  projectId: number;
  chapterPosition: number;
}) {
  const currentUser = useCurrentUser();
  const [comment, setComment] = useState('');

  const { data: thread, isLoading } = trpc.comics.getChapterThread.useQuery(
    { projectId, chapterPosition },
    { enabled: projectId > 0 }
  );

  const utils = trpc.useUtils();
  const createComment = trpc.comics.createChapterComment.useMutation({
    onSuccess: () => {
      setComment('');
      utils.comics.getChapterThread.invalidate({ projectId, chapterPosition });
    },
  });

  const handleSubmit = () => {
    if (!comment.trim()) return;
    createComment.mutate({ projectId, chapterPosition, content: comment.trim() });
  };

  return (
    <div>
      <h3 className="text-base font-medium mb-3">
        Comments {thread?.commentCount ? `(${thread.commentCount})` : ''}
      </h3>

      {/* Comment input */}
      {currentUser ? (
        <div className="flex gap-2 mb-4">
          <Textarea
            placeholder="Write a comment..."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="flex-1"
            size="sm"
            autosize
            maxRows={4}
          />
          <Button
            onClick={handleSubmit}
            loading={createComment.isPending}
            disabled={!comment.trim()}
            size="sm"
            variant="filled"
          >
            <IconSend size={16} />
          </Button>
        </div>
      ) : (
        <p className="text-sm text-gray-400 mb-4">
          <Link href="/login" className="text-blue-400 hover:underline">
            Sign in
          </Link>{' '}
          to leave a comment.
        </p>
      )}

      {/* Comment list */}
      {isLoading ? (
        <div className="text-sm text-gray-400">Loading comments...</div>
      ) : !thread?.comments?.length ? (
        <div className="text-sm text-gray-400">No comments yet. Be the first!</div>
      ) : (
        <div className="flex flex-col gap-3">
          {thread.comments.map((c) => (
            <div key={c.id} className="flex gap-2">
              <UserAvatarSimple {...c.user} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{c.user.username}</span>
                  <span className="text-xs text-gray-400">{formatRelativeDate(c.createdAt)}</span>
                </div>
                <p className="text-sm mt-0.5 whitespace-pre-wrap break-words">{c.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeDate(date: Date | string): string {
  const now = new Date();
  const d = new Date(date);
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString();
}

export default Page(PublicComicReader, { header: null });
