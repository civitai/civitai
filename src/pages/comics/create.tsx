import {
  ActionIcon,
  Button,
  Container,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { IconBook, IconPhoto, IconUpload, IconUser, IconX } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { Page } from '~/components/AppLayout/Page';
import { HeroPositionPicker } from '~/components/Comics/HeroPositionPicker';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatGenreLabel } from '~/utils/comic-helpers';
import { ComicGenre } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import styles from './CreateComic.module.scss';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features }) => {
    if (!features?.comicCreator) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: '/login?returnUrl=/comics/create',
          permanent: false,
        },
      };
    }
  },
});

const genreOptions = Object.entries(ComicGenre).map(([key, value]) => ({
  value,
  label: formatGenreLabel(key),
}));

function CreateComicPage() {
  const router = useRouter();
  const currentUser = useCurrentUser();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [genre, setGenre] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [heroUrl, setHeroUrl] = useState<string | null>(null);
  const [heroPosition, setHeroPosition] = useState(50);

  const { uploadToCF: uploadCoverToCF, files: coverFiles } = useCFImageUpload();
  const { uploadToCF: uploadHeroToCF, files: heroFiles } = useCFImageUpload();

  const createProjectMutation = trpc.comics.createProject.useMutation({
    onSuccess: (project) => {
      router.push(`/comics/project/${project.id}`);
    },
  });

  const handleCoverDrop = async (files: File[]) => {
    if (files.length === 0) return;
    const result = await uploadCoverToCF(files[0]);
    setCoverUrl(result.id);
  };

  const handleHeroDrop = async (files: File[]) => {
    if (files.length === 0) return;
    const result = await uploadHeroToCF(files[0]);
    setHeroUrl(result.id);
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    createProjectMutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      genre: (genre as ComicGenre) || undefined,
      coverUrl: coverUrl || undefined,
      heroUrl: heroUrl || undefined,
      heroImagePosition: heroUrl ? heroPosition : undefined,
    });
  };

  const coverUploading = coverFiles.some((f) => f.status === 'uploading');
  const heroUploading = heroFiles.some((f) => f.status === 'uploading');

  // Genre display label for the preview
  const genreLabel = genre ? genreOptions.find((g) => g.value === genre)?.label ?? genre : null;

  return (
    <Container size="xl" py="xl">
      <Title order={2} mb="lg">
        Create Comic Project
      </Title>

      <div className={styles.layout}>
        {/* ── Left: Form ─────────────────────────── */}
        <div className={styles.formColumn}>
          <Stack gap="md">
            {/* ── Images ── */}
            <div>
              <Text size="sm" fw={600} mb={2}>
                Images
              </Text>
              <Text size="xs" c="dimmed" mb="sm">
                Upload a wide hero banner for the comic overview page and a portrait cover for
                browse cards. Both are optional and can be changed later.
              </Text>
            </div>
            <div className={styles.imagesRow}>
              {/* Hero */}
              <div className={styles.heroSection}>
                <Text size="xs" fw={600} c="dimmed" mb={4}>
                  Hero Banner
                </Text>
                {heroUploading ? (
                  <div className={styles.heroDropzone}>
                    <Stack align="center" justify="center" gap={4} h="100%">
                      <Loader size="sm" color="yellow" />
                      <Text size="xs" c="dimmed">
                        Uploading...
                      </Text>
                    </Stack>
                  </div>
                ) : heroUrl ? (
                  <HeroPositionPicker
                    url={heroUrl}
                    position={heroPosition}
                    onPositionChange={setHeroPosition}
                    onRemove={() => {
                      setHeroUrl(null);
                      setHeroPosition(50);
                    }}
                    className={styles.heroPickerWrap}
                  />
                ) : (
                  <Dropzone
                    onDrop={handleHeroDrop}
                    accept={IMAGE_MIME_TYPE}
                    maxFiles={1}
                    className={styles.heroDropzone}
                  >
                    <Stack
                      align="center"
                      justify="center"
                      gap={4}
                      h="100%"
                      style={{ pointerEvents: 'none' }}
                    >
                      <Dropzone.Accept>
                        <IconUpload size={20} className="text-blue-500" />
                      </Dropzone.Accept>
                      <Dropzone.Reject>
                        <IconX size={20} className="text-red-500" />
                      </Dropzone.Reject>
                      <Dropzone.Idle>
                        <IconPhoto size={20} style={{ color: '#909296' }} />
                      </Dropzone.Idle>
                      <Text size="xs" c="dimmed">
                        16:9 banner
                      </Text>
                    </Stack>
                  </Dropzone>
                )}
              </div>

              {/* Cover */}
              <div className={styles.coverSection}>
                <Text size="xs" fw={600} c="dimmed" mb={4}>
                  Cover
                </Text>
                {coverUploading ? (
                  <div className={styles.coverDropzone}>
                    <Stack align="center" justify="center" gap={4} h="100%">
                      <Loader size="xs" color="yellow" />
                      <Text size="xs" c="dimmed">
                        Uploading...
                      </Text>
                    </Stack>
                  </div>
                ) : coverUrl ? (
                  <div className={styles.coverPreviewWrap}>
                    <div className={styles.coverPreview}>
                      <img src={getEdgeUrl(coverUrl, { width: 240 })} alt="Cover" />
                    </div>
                    <ActionIcon
                      variant="filled"
                      color="dark"
                      size="xs"
                      className={styles.removeBtn}
                      onClick={() => setCoverUrl(null)}
                    >
                      <IconX size={12} />
                    </ActionIcon>
                  </div>
                ) : (
                  <Dropzone
                    onDrop={handleCoverDrop}
                    accept={IMAGE_MIME_TYPE}
                    maxFiles={1}
                    className={styles.coverDropzone}
                  >
                    <Stack
                      align="center"
                      justify="center"
                      gap={4}
                      h="100%"
                      style={{ pointerEvents: 'none' }}
                    >
                      <Dropzone.Accept>
                        <IconUpload size={18} className="text-blue-500" />
                      </Dropzone.Accept>
                      <Dropzone.Reject>
                        <IconX size={18} className="text-red-500" />
                      </Dropzone.Reject>
                      <Dropzone.Idle>
                        <IconPhoto size={18} style={{ color: '#909296' }} />
                      </Dropzone.Idle>
                      <Text size="xs" c="dimmed">
                        3:4
                      </Text>
                    </Stack>
                  </Dropzone>
                )}
              </div>
            </div>

            {/* ── Details ── */}
            <div>
              <Text size="sm" fw={600} mb={2}>
                Details
              </Text>
              <Text size="xs" c="dimmed" mb="sm">
                Give your project a name and optionally pick a genre. The description is shown on
                the comic overview page and helps readers discover your work.
              </Text>
            </div>
            <div className={styles.nameGenreRow}>
              <TextInput
                label="Project name"
                placeholder="My Comic"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={styles.nameInput}
              />
              <Select
                label="Genre"
                placeholder="Genre"
                data={genreOptions}
                value={genre}
                onChange={setGenre}
                clearable
                className={styles.genreInput}
              />
            </div>

            <Textarea
              label="Description"
              placeholder="What is your comic about? Set the stage for your readers..."
              maxLength={5000}
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />

            {/* Actions */}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => router.back()}>
                Cancel
              </Button>
              <button
                className={styles.gradientBtn}
                onClick={handleSubmit}
                disabled={!name.trim() || createProjectMutation.isPending}
              >
                {createProjectMutation.isPending ? <Loader size={14} color="dark" /> : null}
                Create Project
              </button>
            </Group>
          </Stack>
        </div>

        {/* ── Right: Live Preview ────────────────── */}
        <div className={styles.previewColumn}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={8} style={{ letterSpacing: 1 }}>
            Reader Preview
          </Text>
          <div className={styles.previewCard}>
            <div className={styles.previewInner}>
              {/* Mini hero */}
              <div className={styles.previewHero}>
                {heroUrl ? (
                  <>
                    <img
                      src={getEdgeUrl(heroUrl, { width: 600 })}
                      alt="Hero preview"
                      className={styles.previewHeroImage}
                      style={{ objectPosition: `center ${heroPosition}%` }}
                    />
                    <div className={styles.previewHeroGradient} />
                  </>
                ) : (
                  <div className={styles.previewHeroEmpty}>
                    <IconPhoto size={28} />
                  </div>
                )}
              </div>

              {/* Mini content area overlapping hero */}
              <div className={styles.previewContent}>
                <p className={styles.previewTitle}>{name.trim() || 'Untitled Comic'}</p>
                <p className={styles.previewCreator}>by {currentUser?.username ?? 'you'}</p>

                {description.trim() && (
                  <p className={styles.previewDescription}>{description.trim()}</p>
                )}

                {/* Stats row */}
                <div className={styles.previewStats}>
                  <span className={styles.previewStatPill}>
                    <span className={styles.previewStatDot} />0 chapters
                  </span>
                  <span className={styles.previewStatPill}>
                    <span className={styles.previewStatDot} />0 panels
                  </span>
                  {genreLabel && (
                    <span className={styles.previewStatPill}>
                      <span className={styles.previewStatDot} />
                      {genreLabel}
                    </span>
                  )}
                </div>

                {/* CTA */}
                <div className={styles.previewCta}>
                  <IconBook size={14} />
                  Start Reading
                </div>

                {/* Chapter section */}
                <div className={styles.previewChapterSection}>
                  <p className={styles.previewChapterTitle}>Chapters</p>
                  <div className={styles.previewChapterItem}>
                    <span className={styles.previewChapterNumber}>1</span>
                    <div className={styles.previewChapterThumb}>
                      <IconPhoto size={12} />
                    </div>
                    <div className={styles.previewChapterInfo}>
                      <p className={styles.previewChapterName}>Chapter 1</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── Card Preview ─────────────────────── */}
          <Text
            size="xs"
            fw={600}
            c="dimmed"
            tt="uppercase"
            mt={24}
            mb={8}
            style={{ letterSpacing: 1 }}
          >
            Card Preview
          </Text>
          <div className={styles.cardPreview}>
            {/* Cover */}
            <div className={styles.cardPreviewCover}>
              {coverUrl ? (
                <img
                  src={getEdgeUrl(coverUrl, { width: 300 })}
                  alt="Cover preview"
                  className={styles.cardPreviewCoverImage}
                />
              ) : (
                <div className={styles.cardPreviewCoverEmpty}>
                  <IconPhoto size={24} />
                </div>
              )}
              {genreLabel && <span className={styles.cardPreviewGenreBadge}>{genreLabel}</span>}
            </div>
            {/* Body */}
            <div className={styles.cardPreviewBody}>
              <p className={styles.cardPreviewTitle}>{name.trim() || 'Untitled Comic'}</p>
              <div className={styles.cardPreviewCreator}>
                <span className={styles.cardPreviewAvatar}>
                  <IconUser size={10} />
                </span>
                <span className={styles.cardPreviewUsername}>{currentUser?.username ?? 'you'}</span>
              </div>
              <span className={styles.cardPreviewChapter}>Ch. 1</span>
            </div>
          </div>
        </div>
      </div>
    </Container>
  );
}

export default Page(CreateComicPage);
