import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Container,
  CopyButton,
  Menu,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconArrowLeft,
  IconBan,
  IconFileTypePdf,
  IconFileZip,
  IconBell,
  IconBellOff,
  IconBolt,
  IconBook,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconColumns,
  IconDotsVertical,
  IconFlag,
  IconLayoutList,
  IconLock,
  IconLink,
  IconMessage,
  IconMessageOff,
  IconPencil,
  IconPhoto,
  IconPhotoOff,
  IconShare,
  IconTrash,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { abbreviateNumber } from '~/utils/number-helpers';
import { ChapterComments } from '~/components/Comics/ChapterComments';
import {
  ChapterExportButton,
  ChapterDownloadButton,
  useChapterExport,
} from '~/components/Comics/ComicExportButton';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import { openSetBrowsingLevelModal } from '~/components/Dialog/triggers/set-browsing-level';
import { useChapterPermission } from '~/components/Comics/comic-chapter.utils';
import type { ComicProjectMeta } from '~/server/schema/comics.schema';
import { Page } from '~/components/AppLayout/Page';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { UserAvatarProfilePicture } from '~/components/UserAvatar/UserAvatarProfilePicture';
import { useBrowsingLevelContext } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { Flags } from '~/shared/utils/flags';
import {
  getBrowsingLevelLabel,
  getHighestBrowsingLevelBit,
  nsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ComicChapterStatus, ComicEngagementType } from '~/shared/utils/prisma/enums';
import { formatRelativeDate } from '~/utils/comic-helpers';
import { slugit } from '~/utils/string-helpers';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import styles from '../Comics.module.scss';

export const getServerSideProps = createServerSideProps({
  resolver: async ({ features }) => {
    if (!features?.comicCreator) return { notFound: true };
    return { props: {} };
  },
});

function PublicComicReader() {
  const router = useRouter();
  const { isGreen } = useFeatureFlags();
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

  // Block NSFW comics on green domain.
  // Project nsfwLevel is bit_or of all chapters, so check for ANY NSFW bits.
  if (isGreen && project.nsfwLevel !== 0 && Flags.intersects(project.nsfwLevel, nsfwBrowsingLevelsFlag)) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <Text>This content is not available on this site</Text>
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
type Chapter = Project['chapters'][number];

// ─── Chapter List Item (uses useChapterPermission hook) ─────────────────────

function ChapterListItem({
  project,
  chapter: ch,
  isRead,
  isBlurred,
  isNsfw,
  onToggleBlur,
  showDownload,
  onChangeNsfwLevel,
}: {
  project: Project;
  chapter: Chapter;
  isRead: boolean;
  isBlurred: boolean;
  isNsfw: boolean;
  onToggleBlur: (e: React.MouseEvent, position: number) => void;
  showDownload?: boolean;
  onChangeNsfwLevel?: (level: number) => void;
}) {
  const { canRead } = useChapterPermission({
    chapterId: ch.id,
    projectUserId: project.user.id,
    earlyAccessEndsAt: ch.earlyAccessEndsAt,
  });

  const isLocked = !canRead;
  const projectSlug = slugit(project.name);
  const thumbUrl = ch.panels[0]?.imageUrl ?? null;
  const daysUntilFree = ch.earlyAccessEndsAt
    ? Math.max(
        0,
        Math.ceil(
          (new Date(ch.earlyAccessEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        )
      )
    : 0;

  return (
    <Link
      href={`/comics/${project.id}/${projectSlug}/${ch.position + 1}/${slugit(ch.name)}`}
      className={styles.chapterListItem}
      style={{ fontWeight: isRead ? 'normal' : 'bold' }}
    >
      <span className={styles.chapterNumber}>{ch.position + 1}</span>
      <div className={styles.chapterThumb}>
        {thumbUrl ? (
          <>
            <img
              src={getEdgeUrl(thumbUrl, { width: 120 })}
              alt={ch.name}
              className={isBlurred ? styles.chapterThumbBlurred : undefined}
            />
            {isBlurred && (
              <button
                className={styles.chapterThumbBadge}
                onClick={(e) => onToggleBlur(e, ch.position)}
                title="Click to show"
              >
                {getBrowsingLevelLabel(ch.nsfwLevel)}
              </button>
            )}
          </>
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
          {ch.status === ComicChapterStatus.Draft && (
            <Badge size="xs" variant="light" color="yellow" ml={4}>
              Draft
            </Badge>
          )}
          {isLocked && (
            <Badge
              size="xs"
              variant="light"
              color="yellow"
              ml={4}
              leftSection={<IconLock size={10} />}
            >
              {ch.earlyAccessConfig?.buzzPrice} Buzz
            </Badge>
          )}
          {isNsfw && (
            <span className="ml-1" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <BrowsingLevelBadge
                browsingLevel={ch.nsfwLevel}
                size="xs"
                onClick={
                  onChangeNsfwLevel
                    ? () =>
                        openSetBrowsingLevelModal({
                          imageId: 0,
                          nsfwLevel: ch.nsfwLevel as any,
                          skipImageUpdate: true,
                          onSubmit: ({ level }) => onChangeNsfwLevel(level),
                        })
                    : undefined
                }
                style={onChangeNsfwLevel ? { cursor: 'pointer' } : undefined}
              />
            </span>
          )}
        </p>
        <p className={styles.chapterPanelCount}>
          {isLocked ? (
            daysUntilFree > 0 ? (
              <>
                Early access · free in {daysUntilFree}{' '}
                {daysUntilFree === 1 ? 'day' : 'days'}
              </>
            ) : (
              <>Early access</>
            )
          ) : (
            <>
              {ch.panelCount} {ch.panelCount === 1 ? 'page' : 'pages'}
              {ch.publishedAt && ` · ${formatRelativeDate(ch.publishedAt)}`}
            </>
          )}
        </p>
      </div>
      {showDownload && (
        <ChapterDownloadButton
          projectName={project.name}
          projectUserId={project.user.id}
          chapter={ch}
        />
      )}
      <IconChevronRight size={18} className={styles.chapterArrow} />
    </Link>
  );
}

// ─── Overview / Landing Page ─────────────────────────────────────────────────

function ComicOverview({ project }: { project: Project }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const isOwner = currentUser?.id === project.user.id;
  const projectMeta = project.meta as ComicProjectMeta | null;
  const { blurLevels } = useBrowsingLevelContext();
  const [unblurredChapters, setUnblurredChapters] = useState<Set<number>>(new Set());
  const toggleChapterBlur = useCallback((e: React.MouseEvent, position: number) => {
    e.preventDefault();
    e.stopPropagation();
    setUnblurredChapters((prev) => {
      const next = new Set(prev);
      if (next.has(position)) next.delete(position);
      else next.add(position);
      return next;
    });
  }, []);

  const isMod = currentUser?.isModerator === true;
  const tippedAmount = useBuzzTippingStore({ entityType: 'ComicProject', entityId: project.id });

  const deleteProject = trpc.comics.deleteProject.useMutation({
    onSuccess: () => void router.push('/comics'),
  });

  const setTosViolation = trpc.comics.setTosViolation.useMutation({
    onSuccess: () => void utils.comics.getPublicProjectForReader.invalidate({ id: project.id }),
  });

  const setProjectNsfwLevel = trpc.comics.setProjectNsfwLevel.useMutation({
    onSuccess: () => void utils.comics.getPublicProjectForReader.invalidate({ id: project.id }),
  });

  const setChapterNsfwLevel = trpc.comics.setChapterNsfwLevel.useMutation({
    onSuccess: () => void utils.comics.getPublicProjectForReader.invalidate({ id: project.id }),
  });

  // Hero image for the wide banner, fallback to cover, then first panel
  const heroImage = project.heroImage ?? project.coverImage;
  const heroUrl =
    heroImage?.url ??
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

  // Guard image for hero — use heroImage/coverImage if available, otherwise project-level.
  // Combine the underlying hero image's nsfwLevel with the project composite
  // so the worst content reachable by clicking through governs the gate, then
  // reduce to the highest single bit: ImageGuard2's blur check
  // (`Flags.hasFlag(blurLevels, nsfwLevel)`) requires every bit of the level
  // to be in the user's blur set. A composite like PG | R = 5 has a PG bit
  // that's NOT in `blurLevels` (which only contains R/X/XXX/Blocked), so
  // the check returns false and the hero never blurs. The single-bit
  // reduction gives the gate a value it accepts and the badge a key it can
  // label.
  const heroBaseNsfwLevel = (heroImage?.nsfwLevel ?? 0) | (project.nsfwLevel ?? 0);
  const heroGuardImage = heroImage
    ? { ...heroImage, nsfwLevel: getHighestBrowsingLevelBit(heroBaseNsfwLevel) }
    : { id: project.id, nsfwLevel: getHighestBrowsingLevelBit(project.nsfwLevel ?? 0) };

  return (
    <>
      <Meta title={`${project.name} - Civitai Comics`} canonical={`/comics/${project.id}`} />

      <div className={styles.overviewRoot}>
        {/* Hero image */}
        <div className={styles.overviewHero}>
          {heroUrl ? (
            <ImageGuard2 image={heroGuardImage}>
              {(safe) =>
                safe ? (
                  <>
                    <img
                      src={getEdgeUrl(heroUrl, { width: 1200 })}
                      alt={project.name}
                      className={styles.overviewHeroImage}
                      style={{ objectPosition: `center ${project.heroImagePosition ?? 50}%` }}
                    />
                    <div className={styles.overviewHeroGradient} />
                  </>
                ) : (
                  <>
                    <div className="absolute inset-0 overflow-hidden">
                      <img
                        src={getEdgeUrl(heroUrl, { width: 1200 })}
                        alt={project.name}
                        className={styles.overviewHeroImage}
                        style={{
                          objectPosition: `center ${project.heroImagePosition ?? 50}%`,
                          filter: 'blur(32px)',
                          transform: 'scale(1.2)',
                        }}
                      />
                    </div>
                    <div className={styles.overviewHeroGradient} />
                  </>
                )
              }
            </ImageGuard2>
          ) : (
            <div className={styles.overviewHeroEmpty}>
              <IconPhoto size={64} />
            </div>
          )}
        </div>

        {/* Content overlapping hero */}
        <Container size="sm" className={styles.overviewContent}>
          {/* TOS violation banner */}
          {project.tosViolation && (
            <Alert color="red" mb="md" icon={<IconBan size={18} />}>
              This comic has been flagged as a TOS violation and is hidden from public listings.
            </Alert>
          )}

          {/* Back link */}
          <div className={styles.overviewMeta}>
            <Link href="/comics" className={styles.overviewBackBtn}>
              <IconArrowLeft size={16} />
              Browse
            </Link>

            {currentUser && (
              <>
                <Tooltip label={isFollowing ? 'Unfollow comic' : 'Get notified of new chapters'}>
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
                </Tooltip>
                {currentUser.id !== project.user.id && (
                  <>
                    <InteractiveTipBuzzButton
                      toUserId={project.user.id}
                      entityId={project.id}
                      entityType="ComicProject"
                    >
                      <IconBadge
                        radius="sm"
                        style={{ cursor: 'pointer' }}
                        color="gray"
                        size="lg"
                        h={28}
                        icon={<IconBolt />}
                      >
                        <span className="text-sm">
                          {abbreviateNumber(
                            (project.tippedAmountCount ?? 0) + tippedAmount
                          )}
                        </span>
                      </IconBadge>
                    </InteractiveTipBuzzButton>
                    <LoginRedirect reason="report-comic">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        onClick={() =>
                          openReportModal({
                            entityType: ReportEntity.ComicProject,
                            entityId: project.id,
                          })
                        }
                      >
                        <IconFlag size={18} />
                      </ActionIcon>
                    </LoginRedirect>
                  </>
                )}
                {isOwner && (
                  <>
                    <Tooltip label="Edit comic">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        component={Link}
                        href={`/comics/project/${project.id}`}
                      >
                        <IconPencil size={18} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete comic">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        loading={deleteProject.isPending}
                        onClick={() =>
                          openConfirmModal({
                            title: 'Delete comic',
                            children:
                              'Are you sure you want to delete this comic? This action cannot be undone.',
                            labels: { confirm: 'Delete', cancel: 'Cancel' },
                            confirmProps: { color: 'red' },
                            onConfirm: () => deleteProject.mutate({ id: project.id }),
                          })
                        }
                      >
                        <IconTrash size={18} />
                      </ActionIcon>
                    </Tooltip>
                  </>
                )}
                {isMod && (
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <Tooltip label="Moderator actions">
                        <ActionIcon variant="subtle" color="yellow">
                          <IconBan size={18} />
                        </ActionIcon>
                      </Tooltip>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Label>Moderator</Menu.Label>
                      <Menu.Item
                        leftSection={<IconBan size={14} stroke={1.5} />}
                        color={project.tosViolation ? 'green' : 'red'}
                        onClick={() =>
                          openConfirmModal({
                            title: project.tosViolation
                              ? 'Remove TOS Violation Flag'
                              : 'Flag as TOS Violation',
                            children: project.tosViolation
                              ? 'This will remove the TOS violation flag and make the comic visible again.'
                              : 'This will flag the comic as a TOS violation and hide it from public listings. The creator will be notified.',
                            labels: {
                              confirm: project.tosViolation ? 'Remove Flag' : 'Flag',
                              cancel: 'Cancel',
                            },
                            confirmProps: {
                              color: project.tosViolation ? 'green' : 'red',
                            },
                            onConfirm: () => setTosViolation.mutate({ id: project.id }),
                          })
                        }
                      >
                        {project.tosViolation ? 'Remove TOS Flag' : 'Flag as TOS Violation'}
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                )}
              </>
            )}
          </div>

          {/* Title + content rating */}
          <div className="flex items-center gap-2">
            <h1 className={styles.overviewTitle}>{project.name}</h1>
            {project.nsfwLevel > 0 && (
              <BrowsingLevelBadge
                browsingLevel={project.nsfwLevel}
                onClick={
                  isMod
                    ? () =>
                        openSetBrowsingLevelModal({
                          imageId: 0,
                          nsfwLevel: project.nsfwLevel as any,
                          skipImageUpdate: true,
                          onSubmit: ({ level }) =>
                            setProjectNsfwLevel.mutate({ id: project.id, nsfwLevel: level }),
                        })
                    : undefined
                }
                style={isMod ? { cursor: 'pointer' } : undefined}
              />
            )}
          </div>

          {/* Creator */}
          <div className={styles.overviewCreatorRow}>
            <UserAvatarSimple {...project.user} />
          </div>

          {/* Description */}
          {project.description && (
            <p className={styles.overviewDescription}>{project.description}</p>
          )}

          {/* Share */}
          <div className="mt-4 flex items-center gap-2">
            <CopyButton
              value={
                typeof window !== 'undefined'
                  ? `${window.location.origin}/comics/${project.id}/${projectSlug}`
                  : ''
              }
            >
              {({ copied, copy }) => (
                <Tooltip label={copied ? 'Copied!' : 'Copy link'}>
                  <ActionIcon variant="subtle" color={copied ? 'green' : 'gray'} onClick={copy}>
                    {copied ? <IconCheck size={18} /> : <IconLink size={18} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
            <ActionIcon
              variant="subtle"
              color="gray"
              component="a"
              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                `Check out "${project.name}" on Civitai Comics!`
              )}&url=${encodeURIComponent(
                typeof window !== 'undefined'
                  ? `${window.location.origin}/comics/${project.id}/${projectSlug}`
                  : ''
              )}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <IconShare size={18} />
            </ActionIcon>
          </div>

          {/* Stats */}
          <div className={styles.overviewStats}>
            <span className={styles.overviewStatPill}>
              <span className={styles.overviewStatDot} />
              {project.chapters.length} {project.chapters.length === 1 ? 'chapter' : 'chapters'}
            </span>
          </div>

          {/* CTA */}
          {(() => {
            const hasPublishedChapters = project.chapters.some(
              (ch) => ch.status === ComicChapterStatus.Published && ch.panels.length > 0
            );
            const hasAnyPanels = project.chapters.some((ch) => ch.panels.length > 0);
            if (hasPublishedChapters) {
              const firstReadable = project.chapters.find((ch) => ch.panels.length > 0);
              return (
                <Link
                  href={`/comics/${project.id}/${projectSlug}/${
                    (project.chapters.indexOf(firstReadable!) ?? 0) + 1
                  }/${slugit(firstReadable?.name ?? 'chapter')}`}
                  className={styles.ctaBtn}
                >
                  <IconBook size={20} />
                  Start Reading
                </Link>
              );
            }
            if (isOwner && hasAnyPanels) {
              return (
                <Link
                  href={`/comics/project/${project.id}/read`}
                  className={styles.ctaBtn}
                >
                  <IconBook size={20} />
                  Preview
                </Link>
              );
            }
            return null;
          })()}

          {/* Chapter list */}
          <div className={styles.chapterSection}>
            <p className={styles.chapterSectionTitle}>Chapters</p>
            <div className="flex flex-col gap-2">
              {project.chapters.map((ch) => (
                <ChapterListItem
                  key={`${ch.projectId}-${ch.position}`}
                  project={project}
                  chapter={ch}
                  isRead={readPositions ? readPositions.includes(ch.position) : false}
                  isBlurred={
                    ch.nsfwLevel > 0 &&
                    Flags.hasFlag(blurLevels, ch.nsfwLevel) &&
                    !unblurredChapters.has(ch.position)
                  }
                  isNsfw={ch.nsfwLevel > 0 && Flags.hasFlag(blurLevels, ch.nsfwLevel)}
                  onToggleBlur={toggleChapterBlur}
                  showDownload={projectMeta?.allowDownload || isOwner || isMod}
                  onChangeNsfwLevel={(level) =>
                    setChapterNsfwLevel.mutate({
                      projectId: project.id,
                      chapterPosition: ch.position,
                      nsfwLevel: level,
                    })
                  }
                />
              ))}
            </div>
          </div>
        </Container>
      </div>
    </>
  );
}

// ─── Chapter Reader ──────────────────────────────────────────────────────────

// Versioned key — the previous key may hold 'scroll' or a removed mode.
// Bumping the suffix lets new readers land on the rebuilt 'pages' mode
// (fill-viewport, edge nav, floating counter); users who pick 'scroll' or
// 'pages' under the new key keep their pref.
const READER_MODE_KEY = 'civitai-comic-reader-mode-v3';
const READER_COMMENTS_KEY = 'civitai-comic-reader-comments';
type ReaderMode = 'scroll' | 'pages';

function ChapterReader({ project, chapterDbPos }: { project: Project; chapterDbPos: number }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const availableBuzzTypes = useAvailableBuzz();
  const chapters = project.chapters;
  const chapterIdx = chapters.findIndex((ch) => ch.position === chapterDbPos);
  const safeIdx = chapterIdx >= 0 ? chapterIdx : 0;
  const activeChapter = chapters[safeIdx];
  const panels = activeChapter?.panels ?? [];
  const headerRef = useRef<HTMLDivElement>(null);
  const projectMeta = project.meta as ComicProjectMeta | null;
  const { canRead, canDownload } = useChapterPermission({
    chapterId: activeChapter?.id,
    projectUserId: project.user.id,
    earlyAccessEndsAt: activeChapter?.earlyAccessEndsAt,
  });
  const lastScrollTop = useRef(0);

  // Reader mode: pages (default — bifold 2-panel spread filling the
  // viewport, edge-anchored nav) or scroll (long-form vertical scroll).
  // On mobile we force scroll regardless of the saved preference: a 2-panel
  // spread on a phone-sized screen renders unreadably small and the
  // edge-anchored arrows fight the OS gesture areas.
  const isMobile = useMediaQuery('(max-width: 768px)');
  const [readerMode, setReaderMode] = useState<ReaderMode>(() => {
    if (typeof window === 'undefined') return 'pages';
    const saved = localStorage.getItem(READER_MODE_KEY) as ReaderMode | null;
    return saved && ['scroll', 'pages'].includes(saved) ? saved : 'pages';
  });
  const effectiveReaderMode: ReaderMode = isMobile ? 'scroll' : readerMode;
  const [pageIndex, setPageIndex] = useState(0);
  const PANELS_PER_PAGE = 2;
  const handleModeChange = (mode: string) => {
    const m = mode as ReaderMode;
    setReaderMode(m);
    setPageIndex(0);
    localStorage.setItem(READER_MODE_KEY, m);
  };

  // Comments visibility — togglable from the header. Persisted so the user's
  // choice survives chapter navigation and refreshes.
  const [commentsVisible, setCommentsVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem(READER_COMMENTS_KEY) !== 'false';
  });
  const toggleComments = useCallback(() => {
    setCommentsVisible((prev) => {
      const next = !prev;
      localStorage.setItem(READER_COMMENTS_KEY, String(next));
      return next;
    });
  }, []);

  // Chapter export — used both by the desktop inline icon and by the
  // mobile kebab menu's "Download" items so the format choice gets
  // proper text labels there instead of an iconbutton-in-menu hack.
  const exportPanels = activeChapter?.panels ?? [];
  const exportChapterName = activeChapter?.name ?? '';
  const { exporting: isExporting, exportCBZ, exportPDF } = useChapterExport({
    projectName: project.name,
    chapterName: exportChapterName,
    panels: exportPanels,
  });

  // Pages mode: compute page spreads (pairs of panels)
  const totalPages = Math.ceil(panels.length / PANELS_PER_PAGE);
  const visiblePanels =
    effectiveReaderMode === 'pages'
      ? panels.slice(pageIndex * PANELS_PER_PAGE, (pageIndex + 1) * PANELS_PER_PAGE)
      : panels;
  const hasPagePrev = pageIndex > 0;
  const hasPageNext = pageIndex < totalPages - 1;

  const goPage = (dir: 1 | -1) => {
    const next = pageIndex + dir;
    if (next >= 0 && next < totalPages) {
      setPageIndex(next);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (dir === 1 && hasNext) {
      goToChapter(safeIdx + 1);
    } else if (dir === -1 && hasPrev) {
      const prevChapter = chapters[safeIdx - 1];
      const prevPanelCount = prevChapter?.panels.length ?? 0;
      const lastPage = Math.max(0, Math.ceil(prevPanelCount / PANELS_PER_PAGE) - 1);
      goToChapter(safeIdx - 1, lastPage);
    }
  };


  // Connection key for ImageGuard2 — all panels in a chapter share the same key
  const chapterConnectId = `${project.id}-${activeChapter?.position ?? 0}`;

  const projectSlug = slugit(project.name);

  const chapterOptions = useMemo(
    () =>
      chapters.map((ch, i) => ({
        value: String(i),
        label:
          ch.status === ComicChapterStatus.Draft
            ? `Ch. ${ch.position + 1}: ${ch.name} (Draft)`
            : `Ch. ${ch.position + 1}: ${ch.name}`,
      })),
    [chapters]
  );

  const hasPrev = safeIdx > 0;
  const hasNext = safeIdx < chapters.length - 1;

  const goToChapter = (idx: number, startPage = 0) => {
    const ch = chapters[idx];
    if (!ch) return;
    setPageIndex(startPage);
    window.scrollTo({ top: 0 });
    void router.replace(
      `/comics/${project.id}/${projectSlug}/${ch.position + 1}/${slugit(ch.name)}`,
      undefined,
      { shallow: true }
    );
  };

  // Auto-mark chapter as read
  const markRead = trpc.comics.markChapterRead.useMutation();
  useEffect(() => {
    if (currentUser && activeChapter && canRead) {
      markRead.mutate({ projectId: project.id, chapterPosition: activeChapter.position });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChapter?.position, canRead, currentUser?.id]);

  const isMod = currentUser?.isModerator === true;

  // Early access purchase
  const queryUtils = trpc.useUtils();
  const purchaseAccessMutation = trpc.comics.purchaseChapterAccess.useMutation({
    onSuccess: () => {
      // Refetch the project to pick up any chapter-level changes...
      void queryUtils.comics.getPublicProjectForReader.invalidate({ id: project.id });
      // ...AND the EntityAccess record that `useChapterPermission` reads
      // to compute `canRead`. Without this, the user pays successfully but
      // the paywall stays up because `getEntityAccess` returns the cached
      // pre-purchase state until the user navigates away.
      void queryUtils.common.getEntityAccess.invalidate();
    },
  });

  // Moderator: unpublish chapter
  const modUnpublishMutation = trpc.comics.moderatorUnpublishChapter.useMutation({
    onSuccess: () => {
      queryUtils.comics.getPublicProjectForReader.invalidate({ id: project.id });
    },
  });

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (effectiveReaderMode === 'pages') {
        // In pages mode, arrow keys navigate pages (not chapters)
        if (e.key === 'ArrowLeft') goPage(-1);
        else if (e.key === 'ArrowRight') goPage(1);
      } else {
        if (e.key === 'ArrowLeft' && hasPrev) goToChapter(safeIdx - 1);
        else if (e.key === 'ArrowRight' && hasNext) goToChapter(safeIdx + 1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasPrev, hasNext, safeIdx, effectiveReaderMode, pageIndex, totalPages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hide reader header on scroll down, show on scroll up (scroll mode only).
  // Mobile bails out — the header is non-sticky there (`position: static`)
  // so it scrolls away naturally; running translate-Y on top of that just
  // wastes work.
  const handleScroll = useCallback(() => {
    if (!headerRef.current || effectiveReaderMode === 'pages' || isMobile) return;
    const scrollTop = window.scrollY;
    if (scrollTop > lastScrollTop.current && scrollTop > 80) {
      headerRef.current.style.transform = 'translateY(-100%)';
    } else {
      headerRef.current.style.transform = 'translateY(0)';
    }
    lastScrollTop.current = scrollTop;
  }, [effectiveReaderMode, isMobile]);

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Ensure header is visible in pages mode
  useEffect(() => {
    if (effectiveReaderMode === 'pages' && headerRef.current) {
      headerRef.current.style.transform = 'translateY(0)';
    }
  }, [effectiveReaderMode]);

  // Render a single panel with ImageGuard2 support
  const renderPanel = (panel: (typeof panels)[number]) => {
    if (!panel.imageUrl) return null;
    const panelSrc = getEdgeUrl(panel.imageUrl, { width: 1200 });

    if (panel.image) {
      return (
        <div key={panel.id} className="relative">
          <ImageGuard2
            image={panel.image}
            connectType="comicChapter"
            connectId={chapterConnectId}
          >
            {(safe) =>
              safe ? (
                <>
                  <img
                    src={panelSrc}
                    alt={panel.prompt}
                    loading="lazy"
                    className={styles.readerPanel}
                  />
                  <ImageGuard2.BlurToggle className="absolute top-2 left-2 z-10" />
                </>
              ) : (
                <>
                  <div className={styles.readerPanelBlurWrap}>
                    <img
                      src={panelSrc}
                      alt={panel.prompt}
                      loading="lazy"
                      className={styles.readerPanel}
                      aria-hidden
                    />
                    <img
                      src={panelSrc}
                      alt={panel.prompt}
                      loading="lazy"
                      className={styles.readerPanelBlurred}
                    />
                  </div>
                  <ImageGuard2.BlurToggle className="absolute top-2 left-2 z-10" />
                </>
              )
            }
          </ImageGuard2>
        </div>
      );
    }

    return (
      <img
        key={panel.id}
        src={panelSrc}
        alt={panel.prompt}
        loading="lazy"
        className={styles.readerPanel}
      />
    );
  };

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
      <Meta title={`${activeChapter?.name ?? 'Chapter'} - ${project.name} - Civitai Comics`} deIndex={true} />

      <div className={styles.readerRoot}>
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
                {/* Avatar only — username text rides below the title via */}
                {/* the existing `by {username}` link so we don't duplicate. */}
                {project.user.profilePicture && (
                  <Link
                    href={`/user/${project.user.username}`}
                    aria-label={`Visit ${project.user.username}'s profile`}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      overflow: 'hidden',
                      flexShrink: 0,
                      display: 'inline-block',
                    }}
                  >
                    <UserAvatarProfilePicture
                      id={project.user.id}
                      username={project.user.username}
                      image={project.user.profilePicture}
                      width={64}
                    />
                  </Link>
                )}
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
                {/* Mode toggle hidden on mobile — pages mode is forced off */}
                {/* there since a 2-panel spread is unreadable on a phone, */}
                {/* so there's nothing meaningful to switch to. */}
                {!isMobile && (
                  <SegmentedControl
                    size="xs"
                    aria-label="Reading mode"
                    value={readerMode}
                    onChange={handleModeChange}
                    data={[
                      {
                        value: 'pages',
                        label: (
                          <Tooltip label="Page view">
                            <span role="img" aria-label="Page view">
                              <IconColumns size={16} />
                            </span>
                          </Tooltip>
                        ),
                      },
                      {
                        value: 'scroll',
                        label: (
                          <Tooltip label="Scroll view">
                            <span role="img" aria-label="Scroll view">
                              <IconLayoutList size={16} />
                            </span>
                          </Tooltip>
                        ),
                      },
                    ]}
                  />
                )}
                <Tooltip label={commentsVisible ? 'Hide comments' : 'Show comments'}>
                  <ActionIcon
                    variant="subtle"
                    color={commentsVisible ? 'gray' : 'yellow'}
                    onClick={toggleComments}
                    aria-label={commentsVisible ? 'Hide comments' : 'Show comments'}
                  >
                    {commentsVisible ? (
                      <IconMessage size={16} />
                    ) : (
                      <IconMessageOff size={16} />
                    )}
                  </ActionIcon>
                </Tooltip>
                {/* Chapter prev/next chevrons are redundant with the Select */}
                {/* and crowd the mobile header — desktop-only. */}
                {!isMobile && (
                  <ActionIcon
                    variant="subtle"
                    disabled={!hasPrev}
                    onClick={() => goToChapter(safeIdx - 1)}
                  >
                    <IconChevronLeft size={18} />
                  </ActionIcon>
                )}
                <Select
                  size="xs"
                  data={chapterOptions}
                  value={String(safeIdx)}
                  onChange={(v) => v !== null && goToChapter(Number(v))}
                  styles={{ input: { width: isMobile ? 130 : 160 } }}
                  allowDeselect={false}
                />
                {!isMobile && (
                  <ActionIcon
                    variant="subtle"
                    disabled={!hasNext}
                    onClick={() => goToChapter(safeIdx + 1)}
                  >
                    <IconChevronRight size={18} />
                  </ActionIcon>
                )}
                {/* Desktop: secondary actions inline. */}
                {!isMobile && (
                  <>
                    <CopyButton
                      value={typeof window !== 'undefined' ? window.location.href : ''}
                    >
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied!' : 'Copy link'}>
                          <ActionIcon
                            variant="subtle"
                            color={copied ? 'green' : 'gray'}
                            onClick={copy}
                          >
                            {copied ? <IconCheck size={16} /> : <IconLink size={16} />}
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </CopyButton>
                    {activeChapter &&
                      canDownload &&
                      (projectMeta?.allowDownload ||
                        currentUser?.id === project.user.id ||
                        currentUser?.isModerator) && (
                        <ChapterExportButton
                          projectName={project.name}
                          chapterName={activeChapter.name}
                          panels={activeChapter.panels}
                        />
                      )}
                    {currentUser && currentUser.id !== project.user.id && (
                      <LoginRedirect reason="report-comic">
                        <Tooltip label="Report comic">
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            onClick={() =>
                              openReportModal({
                                entityType: ReportEntity.ComicProject,
                                entityId: project.id,
                              })
                            }
                          >
                            <IconFlag size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </LoginRedirect>
                    )}
                    {isMod && activeChapter?.status === ComicChapterStatus.Published && (
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                          <Tooltip label="Moderator actions">
                            <ActionIcon variant="subtle" color="yellow">
                              <IconBan size={18} />
                            </ActionIcon>
                          </Tooltip>
                        </Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Label>Moderator</Menu.Label>
                          <Menu.Item
                            leftSection={<IconBan size={14} stroke={1.5} />}
                            color="red"
                            onClick={() =>
                              openConfirmModal({
                                title: 'Unpublish Chapter',
                                children:
                                  'This will unpublish the chapter and revert it to draft. The creator will be notified.',
                                labels: { confirm: 'Unpublish', cancel: 'Cancel' },
                                confirmProps: { color: 'red' },
                                onConfirm: () =>
                                  modUnpublishMutation.mutate({
                                    projectId: project.id,
                                    chapterPosition: activeChapter.position,
                                  }),
                              })
                            }
                          >
                            Unpublish Chapter
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    )}
                  </>
                )}
                {/* Mobile: collapse Copy / Export / Report / Mod into a */}
                {/* single kebab menu so the header stays a clean two rows */}
                {/* (title above, Select + comments + kebab below). */}
                {isMobile && (
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon variant="subtle" color="gray" aria-label="More actions">
                        <IconDotsVertical size={18} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconLink size={14} />}
                        onClick={() => {
                          if (typeof window !== 'undefined' && navigator?.clipboard) {
                            void navigator.clipboard.writeText(window.location.href);
                          }
                        }}
                      >
                        Copy link
                      </Menu.Item>
                      {activeChapter &&
                        canDownload &&
                        (projectMeta?.allowDownload ||
                          currentUser?.id === project.user.id ||
                          currentUser?.isModerator) && (
                          <>
                            <Menu.Divider />
                            <Menu.Label>Download</Menu.Label>
                            <Menu.Item
                              leftSection={<IconFileZip size={14} />}
                              onClick={exportCBZ}
                              disabled={isExporting}
                            >
                              Download CBZ
                            </Menu.Item>
                            <Menu.Item
                              leftSection={<IconFileTypePdf size={14} />}
                              onClick={exportPDF}
                              disabled={isExporting}
                            >
                              Download PDF
                            </Menu.Item>
                          </>
                        )}
                      {currentUser && currentUser.id !== project.user.id && (
                        <Menu.Item
                          leftSection={<IconFlag size={14} />}
                          onClick={() =>
                            openReportModal({
                              entityType: ReportEntity.ComicProject,
                              entityId: project.id,
                            })
                          }
                        >
                          Report
                        </Menu.Item>
                      )}
                      {isMod &&
                        activeChapter?.status === ComicChapterStatus.Published && (
                          <>
                            <Menu.Divider />
                            <Menu.Label>Moderator</Menu.Label>
                            <Menu.Item
                              leftSection={<IconBan size={14} stroke={1.5} />}
                              color="red"
                              onClick={() =>
                                openConfirmModal({
                                  title: 'Unpublish Chapter',
                                  children:
                                    'This will unpublish the chapter and revert it to draft. The creator will be notified.',
                                  labels: { confirm: 'Unpublish', cancel: 'Cancel' },
                                  confirmProps: { color: 'red' },
                                  onConfirm: () =>
                                    modUnpublishMutation.mutate({
                                      projectId: project.id,
                                      chapterPosition: activeChapter.position,
                                    }),
                                })
                              }
                            >
                              Unpublish Chapter
                            </Menu.Item>
                          </>
                        )}
                    </Menu.Dropdown>
                  </Menu>
                )}
              </div>
            </div>
          </Container>
        </div>

        {!canRead ? (
          /* ── Paywall screen ── */
          <Container size="sm" py="xl">
            <Stack align="center" gap="lg" py={60}>
              <IconLock size={64} style={{ color: '#605e6e' }} />
              <Title order={3} ta="center">
                {activeChapter.name}
              </Title>
              <Text c="dimmed" ta="center" maw={400}>
                This chapter is in early access.
                {activeChapter.earlyAccessEndsAt && (
                  <>
                    {' '}
                    It will become free in{' '}
                    {Math.max(
                      0,
                      Math.ceil(
                        (new Date(activeChapter.earlyAccessEndsAt).getTime() - Date.now()) /
                          (1000 * 60 * 60 * 24)
                      )
                    )}{' '}
                    days.
                  </>
                )}
              </Text>
              <BuzzTransactionButton
                buzzAmount={activeChapter.earlyAccessConfig?.buzzPrice ?? 0}
                accountTypes={availableBuzzTypes}
                label={`Unlock for ${activeChapter.earlyAccessConfig?.buzzPrice ?? 0} Buzz`}
                onPerformTransaction={() =>
                  purchaseAccessMutation.mutate({ chapterId: activeChapter.id })
                }
                loading={purchaseAccessMutation.isLoading}
                error={purchaseAccessMutation.error?.message}
                size="lg"
              />
              <Link href={`/comics/${project.id}/${projectSlug}`} className={styles.notFoundLink}>
                <IconArrowLeft size={16} />
                Back to overview
              </Link>
            </Stack>
            {/* Chapter navigation below paywall */}
            <ChapterNav />
          </Container>
        ) : (
          <>
            {/* Top nav — Pages mode owns its own edge-anchored arrows + */}
            {/* floating counter, so the redundant button bar is hidden. */}
            {/* Scroll mode keeps the chapter prev/next bar at the top, but */}
            {/* only on desktop — on mobile it's redundant with the bottom */}
            {/* row that appears after the user scrolls through the chapter. */}
            {panels.length > 0 && effectiveReaderMode === 'scroll' && !isMobile && (
              <Container size="sm">
                <ChapterNav />
              </Container>
            )}

            {/* Panel content */}
            {effectiveReaderMode === 'pages' ? (
              // ── Pages mode (default) ──
              // The current spread (1–2 panels) fills the viewport.
              // Edge-anchored prev/next + top-center floating counter +
              // arrow-key nav. Comments live below the fold; users can
              // scroll past the spread to see them or hide them via the
              // header toggle.
              panels.length === 0 ? (
                <div className={styles.readerEmpty}>
                  <IconPhotoOff size={48} />
                  <p>No panels in this chapter</p>
                  <Link
                    href={`/comics/${project.id}/${projectSlug}`}
                    className={styles.notFoundLink}
                  >
                    <IconArrowLeft size={16} />
                    Back to overview
                  </Link>
                </div>
              ) : (
                // The spread already manages its own size via
                // `.readerPagesSpread` SCSS (`height: calc(100dvh - 140px);
                // overflow: hidden`), so this wrapper is just the
                // positioning context for the floating counter / arrows.
                <div style={{ position: 'relative' }}>
                  {/* Floating page counter */}
                  <div
                    style={{
                      position: 'absolute',
                      top: 16,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      zIndex: 5,
                      padding: '4px 12px',
                      background: 'rgba(0,0,0,0.6)',
                      color: 'white',
                      borderRadius: 999,
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    {pageIndex + 1} / {totalPages}
                  </div>

                  {/* Edge-anchored prev/next. Wraps to prev/next chapter */}
                  {/* at boundaries, matching the existing `goPage` logic. */}
                  <ActionIcon
                    variant="filled"
                    color="dark"
                    size="xl"
                    radius="xl"
                    disabled={!hasPagePrev && !hasPrev}
                    onClick={() => goPage(-1)}
                    aria-label={hasPagePrev ? 'Previous page' : 'Previous chapter'}
                    style={{
                      position: 'absolute',
                      left: 16,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      zIndex: 5,
                      opacity: hasPagePrev || hasPrev ? 0.85 : 0.3,
                    }}
                  >
                    <IconChevronLeft size={28} />
                  </ActionIcon>
                  <ActionIcon
                    variant="filled"
                    color="dark"
                    size="xl"
                    radius="xl"
                    disabled={!hasPageNext && !hasNext}
                    onClick={() => goPage(1)}
                    aria-label={hasPageNext ? 'Next page' : 'Next chapter'}
                    style={{
                      position: 'absolute',
                      right: 16,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      zIndex: 5,
                      opacity: hasPageNext || hasNext ? 0.85 : 0.3,
                    }}
                  >
                    <IconChevronRight size={28} />
                  </ActionIcon>

                  <div className={styles.readerPagesSpread}>
                    {visiblePanels.map((panel) => renderPanel(panel))}
                  </div>
                </div>
              )
            ) : (
              <Container size="md" p={0}>
                {panels.length === 0 ? (
                  <div className={styles.readerEmpty}>
                    <IconPhotoOff size={48} />
                    <p>No panels in this chapter</p>
                    <Link
                      href={`/comics/${project.id}/${projectSlug}`}
                      className={styles.notFoundLink}
                    >
                      <IconArrowLeft size={16} />
                      Back to overview
                    </Link>
                  </div>
                ) : (
                  <div className={styles.readerPanels}>
                    {visiblePanels.map((panel) => renderPanel(panel))}
                  </div>
                )}
              </Container>
            )}

            {/* Bottom nav — only for scroll mode; pages mode uses its */}
            {/* edge-anchored arrows for navigation. */}
            {panels.length > 0 && effectiveReaderMode === 'scroll' && (
              <Container size="sm">
                <ChapterNav />
              </Container>
            )}

            {/* Comments section — togglable from header. Hidden when */}
            {/* `commentsVisible` is false; the toggle button preserves the */}
            {/* user's choice across navigation via localStorage. */}
            {activeChapter && commentsVisible && (
              <Container size="sm" py="xl">
                <ChapterComments
                  projectId={project.id}
                  chapterPosition={activeChapter.position}
                  userId={project.user.id}
                />
              </Container>
            )}
          </>
        )}
      </div>
    </>
  );
}

export default Page(PublicComicReader);
