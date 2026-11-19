import { Alert, Container, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import type { ContentCredentialsResult } from '~/server/services/content-credentials.service';

const ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic'];
const MAX_BYTES = 10 * 1024 * 1024;

type State =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'done'; result: ContentCredentialsResult }
  | { status: 'error'; message: string };

export default function IsThisAiPage() {
  const [state, setState] = useState<State>({ status: 'idle' });

  async function check(file: File) {
    setState({ status: 'checking' });
    try {
      const res = await fetch('/api/v1/verify', { method: 'POST', body: file });
      const body = await res.json();
      setState(
        res.ok
          ? { status: 'done', result: body }
          : { status: 'error', message: body.error ?? 'Something went wrong. Try again.' }
      );
    } catch {
      setState({ status: 'error', message: 'Something went wrong. Try again.' });
    }
  }

  return (
    <>
      <Meta
        title="Is this AI? Check an image | Civitai"
        description="Check an image's Content Credentials (C2PA) to see how it was made."
        canonical="/safety/is-this-ai"
      />
      <Container size="sm" className="py-8">
        <Stack gap="md">
          <Title order={1}>Is this AI? Check an image</Title>
          <Text>
            Drop an image to read its Content Credentials (the C2PA standard): a signed label that
            records how a file was made. We check the image and discard it; we don&apos;t keep it.
          </Text>
          <Dropzone
            onDrop={([file]) => file && check(file)}
            onReject={() =>
              setState({
                status: 'error',
                message: 'Use a JPEG, PNG, WebP, AVIF or HEIC image up to 10 MB.',
              })
            }
            accept={ACCEPT}
            maxSize={MAX_BYTES}
            multiple={false}
            loading={state.status === 'checking'}
          >
            <Text ta="center" py="xl">
              Drop an image here, or click to choose one (up to 10 MB)
            </Text>
          </Dropzone>
          {state.status === 'checking' && <Loader size="sm" />}
          {state.status === 'error' && <Alert color="red">{state.message}</Alert>}
          {state.status === 'done' && <Result result={state.result} />}
          <Text size="sm" c="dimmed">
            No credentials doesn&apos;t mean an image isn&apos;t AI: most sites remove them when
            they resize or re-save a file. We&apos;re adding an invisible watermark to everything
            made on Civitai that survives this, and this page will check for it once it&apos;s live.
          </Text>
        </Stack>
      </Container>
    </>
  );
}

function Result({ result }: { result: ContentCredentialsResult }) {
  if (result.credentials === 'none')
    return (
      <Alert color="gray" title="No Content Credentials found">
        This file has no C2PA label, so we can&apos;t tell from it how it was made.
      </Alert>
    );
  if (result.credentials === 'unreadable')
    return (
      <Alert color="yellow" title="Content Credentials we couldn't read">
        This file has a C2PA label, but it is damaged or in a form we can&apos;t read.
      </Alert>
    );

  const { signer, generator, aiGenerated } = result;
  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Text fw={600}>
          {result.credentials === 'valid'
            ? 'Content Credentials found, and the file is unchanged since it was signed.'
            : 'Content Credentials found, but the file was changed after it was signed.'}
        </Text>
        <Text size="sm">Says it was made with AI: {aiGenerated ? 'yes' : 'not stated'}</Text>
        {generator && <Text size="sm">Made with: {generator}</Text>}
        {(signer.commonName || signer.issuer) && (
          <Text size="sm">
            Signed by:{' '}
            {[signer.commonName, signer.issuer].filter(Boolean).join(', certificate from ')}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          A signer&apos;s name is part of what was signed, not proof of who signed it.
        </Text>
      </Stack>
    </Paper>
  );
}
