import { ActionIcon, Button, Container, Group, Select, Stack, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconArrowLeft,
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
  IconLock,
  IconPhotoOff,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';

import { ChapterExportButton } from '~/components/Comics/ComicExportButton';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { hasSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { syncAccount } from '~/utils/sync-account';
import { trpc } from '~/utils/trpc';
import sharedStyles from '~/pages/comics/Comics.module.scss';

const PANELS_PER_PAGE = 2;

/**
 * Renders a single panel for the owner-preview reader.
 *
 * Two ways a panel can be blocked:
 *   - Server stripped `imageUrl` to null on green when the panel's
 *     nsfwLevel is mature (the authoritative gate).
 *   - Image record is mature but the URL slipped through (defense-in-depth
 *     client-side check).
 *
 * Mobile callers stack these vertically; desktop callers drop them into
 * the `.readerPagesSpread` flex layout.
 */
function renderOwnerPanel(
  panel: {
    id: number;
    imageUrl: string | null;
    prompt: string;
    image: { nsfwLevel: number } | null;
  },
  isGreen: boolean,
  redHandoffUrl: string | null
) {
  const isNsfwBlocked =
    panel.imageUrl == null ||
    (isGreen && (panel.image ? !hasSafeBrowsingLevel(panel.image.nsfwLevel) : true));
  return (
    <div
      key={panel.id}
      style={{
        position: 'relative',
        // On mobile the parent stacks panels and we want each one
        // to shrink to fit the viewport width — `width: 100%` makes
        // the img fill, `max-width: 100%` keeps it from overflowing.
        width: '100%',
      }}
    >
      {panel.imageUrl && (
        <img
          src={getEdgeUrl(panel.imageUrl, { original: true })}
          alt={isNsfwBlocked ? 'Mature panel' : panel.prompt}
          style={{
            width: '100%',
            display: 'block',
            filter: isNsfwBlocked ? 'blur(40px)' : undefined,
          }}
        />
      )}
      {isNsfwBlocked && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
            textAlign: 'center',
            background: 'rgba(0,0,0,0.55)',
            color: 'white',
            borderRadius: 4,
            minHeight: 200,
          }}
        >
          <IconLock size={28} />
          <Text size="sm" fw={600}>
            Mature panel
          </Text>
          <Text size="xs" c="gray.3" maw={360}>
            This panel is mature content and can&apos;t be viewed on this site. Open the
            chapter on civitai.red to read it.
          </Text>
          {redHandoffUrl && (
            <Button
              component="a"
              href={redHandoffUrl}
              target="_blank"
              rel="noopener noreferrer"
              size="compact-sm"
              variant="light"
              color="red"
              leftSection={<IconExternalLink size={12} />}
            >
              Read on civitai.red
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features }) => {
    if (!features?.comicCreator) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: '/login?returnUrl=/comics',
          permanent: false,
        },
      };
    }
  },
});

function ComicReader() {
  const router = useRouter();
  const { id } = router.query;
  const projectId = Number(id);

  const { data: project, isLoading } = trpc.comics.getProjectForReader.useQuery(
    { id: projectId },
    { enabled: projectId > 0 }
  );

  const chapters = useMemo(() => project?.chapters ?? [], [project?.chapters]);

  // Mobile uses a vertical scroll layout instead of the page spread —
  // a 2-panel spread is unreadable at phone widths and the edge-anchored
  // arrows fight with the OS gesture areas. Matches the public reader's
  // mobile rule.
  const isMobile = useMediaQuery('(max-width: 768px)');

  // Mature-content gating: on the green domain, hide panels that aren't in
  // the safe browsing levels (PG / PG-13). Mirrors PanelCard's `isNsfwBlocked`
  // rule so the reader and the editor agree on what shows up. Panels missing
  // an Image relation default to "blocked" — the safe assumption.
  const { isGreen } = useFeatureFlags();
  const redDomain = useServerDomains().red;

  // Active chapter is driven by `?chapter={position}` so refresh / share /
  // back-button all land on the same chapter. We pick first-with-panels as
  // the silent fallback so an empty new chapter doesn't render a "no panels
  // yet" landing when there's a populated chapter sitting next to it.
  const chapterQueryParam = Array.isArray(router.query.chapter)
    ? router.query.chapter[0]
    : router.query.chapter;
  const urlChapterPosition = (() => {
    if (typeof chapterQueryParam !== 'string') return null;
    const parsed = Number(chapterQueryParam);
    return Number.isFinite(parsed) ? parsed : null;
  })();

  const activeChapterIdx = useMemo(() => {
    if (chapters.length === 0) return -1;
    if (urlChapterPosition != null) {
      const idx = chapters.findIndex((ch) => ch.position === urlChapterPosition);
      if (idx >= 0) return idx;
    }
    const firstWithPanels = chapters.findIndex((ch) => ch.panels.length > 0);
    return firstWithPanels >= 0 ? firstWithPanels : 0;
  }, [chapters, urlChapterPosition]);

  const activeChapter = chapters[activeChapterIdx];
  const panels = activeChapter?.panels ?? [];

  // Page-spread state — same shape as the public reader's pages mode. Two
  // panels per spread, fills the viewport, edge-anchored arrows. Reset to
  // page 0 on every chapter switch.
  const [pageIndex, setPageIndex] = useState(0);
  useEffect(() => {
    setPageIndex(0);
  }, [activeChapterIdx]);
  const totalPages = Math.max(1, Math.ceil(panels.length / PANELS_PER_PAGE));
  const safePageIdx = Math.min(pageIndex, totalPages - 1);
  const visiblePanels = panels.slice(
    safePageIdx * PANELS_PER_PAGE,
    (safePageIdx + 1) * PANELS_PER_PAGE
  );
  const hasPagePrev = safePageIdx > 0;
  const hasPageNext = safePageIdx < totalPages - 1;
  const hasPrevChapter = activeChapterIdx > 0;
  const hasNextChapter = activeChapterIdx < chapters.length - 1;

  const goToChapter = useCallback(
    (idx: number, startPage = 0) => {
      const target = chapters[idx];
      if (!target) return;
      setPageIndex(startPage);
      const nextQuery = { ...router.query, chapter: String(target.position) };
      void router.replace(
        { pathname: router.pathname, query: nextQuery },
        undefined,
        { shallow: true, scroll: false }
      );
      window.scrollTo({ top: 0 });
    },
    [router, chapters]
  );

  // Page-level nav with chapter-boundary wrap, mirroring the public reader.
  const goPage = useCallback(
    (dir: 1 | -1) => {
      const next = safePageIdx + dir;
      if (next >= 0 && next < totalPages) {
        setPageIndex(next);
      } else if (dir === 1 && hasNextChapter) {
        goToChapter(activeChapterIdx + 1);
      } else if (dir === -1 && hasPrevChapter) {
        // Step into the prev chapter's last page so the back-arrow keeps
        // a consistent "previous" feel instead of dumping the user at the
        // start of the previous chapter.
        const prevChapter = chapters[activeChapterIdx - 1];
        const prevPanelCount = prevChapter?.panels.length ?? 0;
        const lastPage = Math.max(0, Math.ceil(prevPanelCount / PANELS_PER_PAGE) - 1);
        goToChapter(activeChapterIdx - 1, lastPage);
      }
    },
    [safePageIdx, totalPages, hasNextChapter, hasPrevChapter, activeChapterIdx, chapters, goToChapter]
  );

  // Keyboard nav — arrow keys flip pages within a chapter and wrap into
  // adjacent chapters at the boundaries. Bail out when the user is typing
  // in the chapter Select so dropdown navigation isn't intercepted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPage(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goPage(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPage]);

  const redHandoffUrl = useMemo(() => {
    if (!redDomain) return null;
    if (!Number.isFinite(projectId) || projectId <= 0) return null;
    const params = activeChapter
      ? `?chapter=${activeChapter.position}`
      : '';
    return syncAccount(`//${redDomain}/comics/project/${projectId}/read${params}`);
  }, [redDomain, projectId, activeChapter]);

  const chapterOptions = useMemo(
    () =>
      chapters.map((ch, i) => ({
        value: String(i),
        label: `${ch.name} (${ch.panels.length})`,
      })),
    [chapters]
  );

  if (isLoading) {
    return (
      <Container size="sm" py="xl">
        <Text c="dimmed">Loading...</Text>
      </Container>
    );
  }

  if (!project) {
    return (
      <Container size="sm" py="xl">
        <Text c="dimmed">Project not found</Text>
      </Container>
    );
  }

  return (
    <>
      <Meta title={`Read ${project.name} - Civitai Comics`} deIndex={true} />

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--mantine-color-dark-8)',
        }}
      >
        {/* Header bar — fixed height; the page spread below grows to fill */}
        {/* the remaining viewport so panels never need scroll-to-center. */}
        <div
          style={{
            zIndex: 100,
            background: 'var(--mantine-color-dark-7)',
            borderBottom: '1px solid var(--mantine-color-dark-5)',
            flexShrink: 0,
          }}
        >
          <Container size="sm">
            <Group justify="space-between" py="xs">
              <Group gap="sm">
                <ActionIcon variant="subtle" component={Link} href={`/comics/project/${projectId}`}>
                  <IconArrowLeft size={20} />
                </ActionIcon>
                <Title order={5} lineClamp={1} style={{ maxWidth: 200 }}>
                  {project.name}
                </Title>
              </Group>

              <Group gap="xs">
                <ActionIcon
                  variant="subtle"
                  disabled={!hasPrevChapter}
                  onClick={() => goToChapter(activeChapterIdx - 1)}
                >
                  <IconChevronLeft size={18} />
                </ActionIcon>
                <Select
                  size="xs"
                  data={chapterOptions}
                  value={String(activeChapterIdx)}
                  onChange={(v) => v !== null && goToChapter(Number(v))}
                  styles={{ input: { width: 160 } }}
                  allowDeselect={false}
                />
                <ActionIcon
                  variant="subtle"
                  disabled={!hasNextChapter}
                  onClick={() => goToChapter(activeChapterIdx + 1)}
                >
                  <IconChevronRight size={18} />
                </ActionIcon>
                {project && activeChapter && (
                  <ChapterExportButton
                    projectName={project.name}
                    chapterName={activeChapter.name}
                    panels={activeChapter.panels}
                  />
                )}
              </Group>
            </Group>
          </Container>
        </div>

        {/* Mobile uses a vertical scroll list; desktop uses the page spread. */}
        {panels.length === 0 ? (
          <Stack align="center" gap="md" py={80}>
            <IconPhotoOff size={48} style={{ color: 'var(--mantine-color-dark-3)' }} />
            <Text c="dimmed">
              {chapters.every((ch) => ch.panels.length === 0)
                ? 'No panels are ready yet. Panels appear here once they finish generating.'
                : 'No panels in this chapter yet'}
            </Text>
            <Button variant="subtle" component={Link} href={`/comics/project/${projectId}`}>
              Back to editor
            </Button>
          </Stack>
        ) : isMobile ? (
          // ── Mobile: vertical scroll of every panel in the chapter. ──
          // No spread, no edge nav, no floating counter — those are
          // hostile UX on a phone. Chapter switching uses the dropdown
          // in the header.
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <Stack gap={0} p="xs">
              {panels.map((panel) => renderOwnerPanel(panel, isGreen, redHandoffUrl))}
            </Stack>
          </div>
        ) : (
          // ── Desktop: 2-panel page spread. ──
          <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
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
              {safePageIdx + 1} / {totalPages}
            </div>

            {/* Edge-anchored prev/next; cross to adjacent chapters at boundaries. */}
            <ActionIcon
              variant="filled"
              color="dark"
              size="xl"
              radius="xl"
              disabled={!hasPagePrev && !hasPrevChapter}
              onClick={() => goPage(-1)}
              aria-label={hasPagePrev ? 'Previous page' : 'Previous chapter'}
              style={{
                position: 'absolute',
                left: 16,
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 5,
                opacity: hasPagePrev || hasPrevChapter ? 0.85 : 0.3,
              }}
            >
              <IconChevronLeft size={28} />
            </ActionIcon>
            <ActionIcon
              variant="filled"
              color="dark"
              size="xl"
              radius="xl"
              disabled={!hasPageNext && !hasNextChapter}
              onClick={() => goPage(1)}
              aria-label={hasPageNext ? 'Next page' : 'Next chapter'}
              style={{
                position: 'absolute',
                right: 16,
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 5,
                opacity: hasPageNext || hasNextChapter ? 0.85 : 0.3,
              }}
            >
              <IconChevronRight size={28} />
            </ActionIcon>

            {/* Spread layout — uses the shared Comics SCSS so this matches */}
            {/* the public reader's pages mode. */}
            <div
              className={sharedStyles.readerPagesSpread}
              style={{ height: '100%' }}
            >
              {visiblePanels.map((panel) => renderOwnerPanel(panel, isGreen, redHandoffUrl))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default Page(ComicReader, {
  scrollable: false,
});
