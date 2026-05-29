/**
 * Mod-only test page for exercising the Model3D publish → view → review loop
 * without burning Meshy credits.
 *
 * Upload a GLB (required) plus optional FBX / OBJ / STL plus a thumbnail
 * image. The thumbnail flows through the standard CF → Image-row → NSFW/CSAM
 * scan pipeline. On submit, the page POSTs to /api/testing/model3d-seed which
 * calls the SAME `upsertModel3DFromWorkflow` service the real PolyGen workflow
 * result handler uses — the resulting Model3D is indistinguishable from a
 * generated one downstream.
 */
import {
  Alert,
  Anchor,
  Button,
  Card,
  Container,
  FileButton,
  Group,
  NumberInput,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconCheck, IconCube, IconUpload, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { Page } from '~/components/AppLayout/Page';
import { getDataFromFile, useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useS3Upload } from '~/hooks/useS3Upload';
import { UploadType } from '~/server/common/enums';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };
    return { props: {} };
  },
});

type ThreeDFormat = 'glb' | 'fbx' | 'obj' | 'stl';

type UploadedFile = {
  format: ThreeDFormat;
  url: string;
  sizeKB: number;
  name: string;
};

type UploadedThumb = {
  url: string;
  name: string;
  width?: number | null;
  height?: number | null;
  hash?: string;
  sizeKB?: number;
};

const FORMAT_LABEL: Record<ThreeDFormat, string> = {
  glb: 'GLB (primary — required)',
  fbx: 'FBX',
  obj: 'OBJ',
  stl: 'STL',
};

const FORMAT_ACCEPT: Record<ThreeDFormat, string> = {
  glb: '.glb',
  fbx: '.fbx',
  obj: '.obj',
  stl: '.stl',
};

function Model3DSeedPage() {
  const { uploadToCF } = useCFImageUpload();
  const { uploadToS3 } = useS3Upload();

  const [name, setName] = useState('Test 3D Model');
  const [description, setDescription] = useState('');
  const [licenseId, setLicenseId] = useState<number>(5);
  const [publish, setPublish] = useState(true);

  const [thumb, setThumb] = useState<UploadedThumb | null>(null);
  const [thumbUploading, setThumbUploading] = useState(false);

  const [files, setFiles] = useState<Partial<Record<ThreeDFormat, UploadedFile>>>({});
  const [fileUploading, setFileUploading] = useState<ThreeDFormat | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ model3dId: number; viewUrl: string } | null>(null);

  const handleThumbnailSelect = async (file: File | null) => {
    if (!file) return;
    setThumbUploading(true);
    setResult(null);
    try {
      // Pull width/height/hash from the local file first so we can pass them
      // to createImage server-side. uploadToCF's return is only { url, id, … }.
      const data = await getDataFromFile(file);
      const upload = await uploadToCF(file);
      // IMPORTANT: store `upload.id` (the CF image UUID) — NOT `upload.url`.
      // `upload.url` is the one-time PUT URL from CF, which is unreadable.
      // EdgeMedia / EdgeMedia2 expect the CF image ID and construct the
      // delivery URL themselves with transforms applied. Storing the upload
      // URL produced cards/thumbnails that rendered broken.
      setThumb({
        url: upload.id,
        name: file.name,
        width: data?.width ?? null,
        height: data?.height ?? null,
        hash: data?.hash,
        sizeKB: file.size / 1024,
      });
      showSuccessNotification({ title: 'Thumbnail uploaded', message: 'Image will be scanned.' });
    } catch (e) {
      showErrorNotification({
        title: 'Thumbnail upload failed',
        error: e instanceof Error ? e : new Error('Unknown upload error'),
      });
    } finally {
      setThumbUploading(false);
    }
  };

  const handleFileSelect = (format: ThreeDFormat) => async (file: File | null) => {
    if (!file) return;
    setFileUploading(format);
    setResult(null);
    try {
      const upload = await uploadToS3(file, UploadType.Model);
      if (!upload.url) throw new Error('No URL returned from upload');
      setFiles((prev) => ({
        ...prev,
        [format]: {
          format,
          url: upload.url,
          sizeKB: (upload.size ?? file.size) / 1024,
          name: file.name,
        },
      }));
      showSuccessNotification({
        title: `${format.toUpperCase()} uploaded`,
        message: `${file.name} ready.`,
      });
    } catch (e) {
      showErrorNotification({
        title: `${format.toUpperCase()} upload failed`,
        error: e instanceof Error ? e : new Error('Unknown upload error'),
      });
    } finally {
      setFileUploading(null);
    }
  };

  const handleSubmit = async () => {
    if (!thumb) {
      showErrorNotification({ title: 'Thumbnail required', error: new Error('Upload a thumbnail first.') });
      return;
    }
    if (!files.glb) {
      showErrorNotification({ title: 'GLB required', error: new Error('Upload a GLB before submitting.') });
      return;
    }

    setSubmitting(true);
    setResult(null);

    try {
      const body = {
        name,
        description: description || undefined,
        licenseId,
        publish,
        thumbnail: thumb,
        files: Object.values(files).filter(Boolean) as UploadedFile[],
        generationParams: {
          source: 'mod-test-page',
          note: 'Seeded via /moderator/testing/model3d-seed',
        },
      };

      const res = await fetch('/api/testing/model3d-seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      setResult({ model3dId: data.model3dId, viewUrl: data.viewUrl });
      showSuccessNotification({
        title: 'Model3D created',
        message: `Draft id ${data.model3dId}${publish ? ' (published)' : ' (draft)'}`,
      });
    } catch (e) {
      showErrorNotification({
        title: 'Seed failed',
        error: e instanceof Error ? e : new Error('Unknown error'),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = !!thumb && !!files.glb && !submitting && !thumbUploading && !fileUploading;

  return (
    <>
      <Meta title="Model3D Seed — Testing" deIndex />
      <Container size="md" py="lg">
        <Stack gap="md">
          <Group gap="xs" align="center">
            <IconCube />
            <Title order={2}>Model3D test seeder</Title>
          </Group>
          <Text size="sm" c="dimmed">
            Upload a GLB (and optional FBX/OBJ/STL) plus a thumbnail. The page calls
            the same <code>upsertModel3DFromWorkflow</code> service the real PolyGen
            workflow uses, with a synthetic <code>workflowId</code> (<code>test-…</code>)
            so the result is indistinguishable from a generated row downstream.
            Thumbnail flows through the standard CF + Image NSFW/CSAM scan pipeline.
          </Text>

          <Card withBorder>
            <Stack gap="sm">
              <Title order={4}>Metadata</Title>
              <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
              <Textarea
                label="Description (optional)"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                minRows={2}
              />
              <NumberInput
                label="License ID"
                description="1=CC-BY 4.0, 2=CC-BY-NC 4.0, 3=Personal Use, 4=No Print Farm, 5=All Rights Reserved, 6=Custom"
                value={licenseId}
                onChange={(v) => setLicenseId(typeof v === 'number' ? v : 5)}
                min={1}
              />
              <Switch
                label="Publish immediately (otherwise stays as Draft)"
                checked={publish}
                onChange={(e) => setPublish(e.currentTarget.checked)}
              />
            </Stack>
          </Card>

          <Card withBorder>
            <Stack gap="sm">
              <Title order={4}>Thumbnail image (required)</Title>
              <Text size="xs" c="dimmed">
                Will be uploaded to Cloudflare and ingested as an Image row that goes
                through standard NSFW/CSAM scanning.
              </Text>
              <FileButton accept="image/*" onChange={handleThumbnailSelect}>
                {(props) => (
                  <Button {...props} loading={thumbUploading} leftSection={<IconUpload size={16} />}>
                    {thumb ? 'Replace thumbnail' : 'Upload thumbnail'}
                  </Button>
                )}
              </FileButton>
              {thumb && (
                <Group gap="sm">
                  <IconCheck size={16} color="green" />
                  <Text size="sm" lineClamp={1}>
                    {thumb.name} ({((thumb.sizeKB ?? 0) / 1024).toFixed(2)} MB)
                  </Text>
                </Group>
              )}
            </Stack>
          </Card>

          <Card withBorder>
            <Stack gap="sm">
              <Title order={4}>3D files</Title>
              <Text size="xs" c="dimmed">
                GLB is required (it&apos;s the primary format the viewer renders). Other
                formats are optional and downloadable via the detail-page format dropdown.
              </Text>
              {(['glb', 'fbx', 'obj', 'stl'] as ThreeDFormat[]).map((fmt) => {
                const uploaded = files[fmt];
                return (
                  <Group key={fmt} justify="space-between" wrap="nowrap">
                    <div style={{ flex: 1 }}>
                      <Text size="sm" fw={fmt === 'glb' ? 600 : 400}>
                        {FORMAT_LABEL[fmt]}
                      </Text>
                      {uploaded && (
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {uploaded.name} ({(uploaded.sizeKB / 1024).toFixed(2)} MB)
                        </Text>
                      )}
                    </div>
                    <Group gap="xs">
                      {uploaded ? (
                        <IconCheck size={16} color="green" />
                      ) : fmt === 'glb' ? (
                        <IconX size={16} color="orange" />
                      ) : null}
                      <FileButton
                        accept={FORMAT_ACCEPT[fmt]}
                        onChange={handleFileSelect(fmt)}
                      >
                        {(props) => (
                          <Button
                            {...props}
                            size="xs"
                            variant={uploaded ? 'default' : 'filled'}
                            loading={fileUploading === fmt}
                            leftSection={<IconUpload size={14} />}
                          >
                            {uploaded ? 'Replace' : 'Upload'}
                          </Button>
                        )}
                      </FileButton>
                    </Group>
                  </Group>
                );
              })}
            </Stack>
          </Card>

          <Button onClick={handleSubmit} disabled={!canSubmit} loading={submitting} size="md">
            Seed Model3D
          </Button>

          {result && (
            <Alert color="green" title="Seed succeeded">
              <Stack gap="xs">
                <Text size="sm">
                  Created Model3D <strong>#{result.model3dId}</strong>.
                </Text>
                <Anchor href={result.viewUrl} target="_blank">
                  Open detail page →
                </Anchor>
                <Anchor href={`${result.viewUrl}/reviews`} target="_blank">
                  Open reviews page →
                </Anchor>
              </Stack>
            </Alert>
          )}
        </Stack>
      </Container>
    </>
  );
}

export default Page(Model3DSeedPage);
