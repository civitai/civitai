import { ActionIcon, Button, Container, Group, Select, Stack, Text, Title } from '@mantine/core';
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
import { useEffect, useMemo, useRef, useState } from 'react';

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

// Mirrors the panel shape returned by `comics.getProjectForReader`. Declared
// here because the inferred tRPC shape is too deep for `panels.map((panel) => ...)`
// to infer cleanly without an explicit annotation.
type ReaderPanel = {
  id: number;
  imageUrl: string | null;
  prompt: string;
  position: number;
  image: { nsfwLevel: number } | null;
};

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
  const [activeChapterIdx, setActiveChapterIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Mature-content gating: on the green domain, hide panels that aren't in
  // the safe browsing levels (PG / PG-13). Mirrors PanelCard's `isNsfwBlocked`
  // rule so the reader and the editor agree on what shows up. Panels missing
  // an Image relation default to "blocked" — the safe assumption.
  const { isGreen } = useFeatureFlags();
  const redDomain = useServerDomains().red;

  const redHandoffUrl = useMemo(() => {
    if (!redDomain) return null;
    if (!Number.isFinite(projectId) || projectId <= 0) return null;
    return syncAccount(`//${redDomain}/comics/project/${projectId}/read`);
  }, [redDomain, projectId]);

  // Reset to first chapter with panels when data loads
  useEffect(() => {
    if (chapters.length > 0) {
      const firstWithPanels = chapters.findIndex((ch) => ch.panels.length > 0);
      if (firstWithPanels >= 0) setActiveChapterIdx(firstWithPanels);
    }
  }, [chapters]);

  const activeChapter = chapters[activeChapterIdx];
  const panels = activeChapter?.panels ?? [];

  const chapterOptions = useMemo(
    () =>
      chapters.map((ch, i) => ({
        value: String(i),
        label: `${ch.name} (${ch.panels.length})`,
      })),
    [chapters]
  );

  const hasPrev = activeChapterIdx > 0;
  const hasNext = activeChapterIdx < chapters.length - 1;

  const goToChapter = (idx: number) => {
    setActiveChapterIdx(idx);
    scrollRef.current?.scrollTo({ top: 0 });
  };

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

  console.log(panels);

  return (
    <>
      <Meta title={`Read ${project.name} - Civitai Comics`} deIndex={true} />

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: 'auto',
          background: 'var(--mantine-color-dark-8)',
        }}
      >
        {/* Sticky header bar */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 100,
            background: 'var(--mantine-color-dark-7)',
            borderBottom: '1px solid var(--mantine-color-dark-5)',
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
                  disabled={!hasPrev}
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
                  disabled={!hasNext}
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

        {/* Panel content */}
        <Container size="sm" p={0}>
        aodoasd
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
          ) : (
            <Stack gap={0}>
              {panels.map((panel: ReaderPanel) => {
                const isNsfwBlocked =
                  isGreen &&
                  (panel.image ? !hasSafeBrowsingLevel(panel.image.nsfwLevel) : true);
                return (
                  <div key={panel.id} style={{ position: 'relative', width: '100%' }}>
                    <img
                      src={getEdgeUrl(panel.imageUrl!, { original: true })}
                      alt={isNsfwBlocked ? 'Mature panel' : panel.prompt}
                      loading="lazy"
                      style={{
                        width: '100%',
                        display: 'block',
                        filter: isNsfwBlocked ? 'blur(40px)' : undefined,
                      }}
                    />
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
                        }}
                      >
                        <IconLock size={28} />
                        <Text size="sm" fw={600}>
                          Mature panel
                        </Text>
                        <Text size="xs" c="gray.3" maw={360}>
                          This panel is mature content and can&apos;t be viewed on this site.
                          Open the chapter on civitai.red to read it.
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
              })}
            </Stack>
          )}
        </Container>

        {/* Bottom nav */}
        {panels.length > 0 && (
          <Container size="sm" py="xl">
            <Group justify="center" gap="md">
              <Button
                variant="default"
                leftSection={<IconChevronLeft size={16} />}
                disabled={!hasPrev}
                onClick={() => goToChapter(activeChapterIdx - 1)}
              >
                Previous Chapter
              </Button>
              <Button
                variant="default"
                rightSection={<IconChevronRight size={16} />}
                disabled={!hasNext}
                onClick={() => goToChapter(activeChapterIdx + 1)}
              >
                Next Chapter
              </Button>
            </Group>
          </Container>
        )}
      </div>
    </>
  );
}

export default Page(ComicReader, {
  scrollable: false,
});
