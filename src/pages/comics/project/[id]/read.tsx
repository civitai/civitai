import { ActionIcon, Button, Container, Group, Select, Stack, Text, Title } from '@mantine/core';
import {
  IconArrowLeft,
  IconChevronLeft,
  IconChevronRight,
  IconPhotoOff,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
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
  const projectId = id as string;

  const { data: project, isLoading } = trpc.comics.getProjectForReader.useQuery(
    { id: projectId },
    { enabled: !!projectId }
  );

  const chapters = useMemo(() => project?.chapters ?? [], [project?.chapters]);
  const [activeChapterIdx, setActiveChapterIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  return (
    <>
      <Meta title={`Read ${project.name} - Civitai Comics`} />

      <div
        ref={scrollRef}
        style={{
          height: '100dvh',
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
              </Group>
            </Group>
          </Container>
        </div>

        {/* Panel content */}
        <Container size="sm" p={0}>
          {panels.length === 0 ? (
            <Stack align="center" gap="md" py={80}>
              <IconPhotoOff size={48} style={{ color: 'var(--mantine-color-dark-3)' }} />
              <Text c="dimmed">No panels in this chapter yet</Text>
              <Button variant="subtle" component={Link} href={`/comics/project/${projectId}`}>
                Back to editor
              </Button>
            </Stack>
          ) : (
            <Stack gap={0}>
              {panels.map((panel) => (
                <img
                  key={panel.id}
                  src={panel.imageUrl!}
                  alt={panel.prompt}
                  loading="lazy"
                  style={{
                    width: '100%',
                    display: 'block',
                  }}
                />
              ))}
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

export default Page(ComicReader, { header: null });
