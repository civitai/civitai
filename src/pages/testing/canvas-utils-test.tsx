import { Badge, Button, Card, Code, Container, Group, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { isProd } from '~/env/other';
import { imageToJpegBlob, resizeImage } from '~/shared/utils/canvas-utils';
import { ExifParser } from '~/utils/metadata';

/**
 * Dev harness for the canvas-utils → @civitai/media-metadata copyMetadata swap:
 * runs the real resize/re-encode paths in the browser against a real on-site
 * civitai image and verifies the generation metadata survives.
 */

const SOURCE_URL =
  'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/c62344b8-c404-4ca4-a20e-83bfd0e16e24/original=true/c62344b8-c404-4ca4-a20e-83bfd0e16e24.jpeg';

type StepResult = {
  name: string;
  ok: boolean;
  detail: string;
};

export default function CanvasUtilsTester() {
  const [results, setResults] = useState<StepResult[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  if (isProd) return null;

  async function run() {
    setRunning(true);
    setError(undefined);
    const out: StepResult[] = [];
    try {
      const sourceBlob = await (await fetch(SOURCE_URL)).blob();
      const sourceFile = new File([sourceBlob], 'source.jpeg', { type: 'image/jpeg' });
      const sourceParser = await ExifParser(sourceFile);
      const sourceMeta = await sourceParser.getMetadata();
      out.push({
        name: 'source parse',
        ok: Object.keys(sourceMeta).length > 0 && sourceParser.isMadeOnSite(),
        detail: `keys=${Object.keys(sourceMeta).length} madeOnSite=${sourceParser.isMadeOnSite()}`,
      });

      const checks: [string, () => Promise<Blob | File>][] = [
        ['resizeImage(maxWidth 512)', () => resizeImage(sourceFile, { maxWidth: 512 })],
        ['imageToJpegBlob(png->jpeg)', async () => imageToJpegBlob(sourceFile)],
      ];
      for (const [name, fn] of checks) {
        const output = await fn();
        const parser = await ExifParser(
          output instanceof File ? output : new File([output], 'out.jpeg')
        );
        const meta = await parser.getMetadata();
        const same = JSON.stringify(meta) === JSON.stringify(sourceMeta);
        out.push({
          name,
          ok: same && parser.isMadeOnSite(),
          detail: `metaEqual=${same} madeOnSite=${parser.isMadeOnSite()} bytes=${output.size}`,
        });
      }
    } catch (e) {
      setError(String(e));
    }
    setResults(out);
    setRunning(false);
  }

  const allOk = results.length > 0 && results.every((r) => r.ok);

  return (
    <Container size="sm" py="xl">
      <Stack>
        <Title order={2}>canvas-utils metadata round-trip</Title>
        <Text c="dimmed">
          Runs resizeImage/imageToJpegBlob (now backed by @civitai/media-metadata copyMetadata) on
          a real on-site image and checks the metadata survives.
        </Text>
        <Button onClick={run} loading={running} data-testid="run">
          Run test
        </Button>
        {error && (
          <Code block c="red" data-testid="error">
            {error}
          </Code>
        )}
        {results.length > 0 && (
          <Card withBorder data-testid="results" data-all-ok={allOk ? 'true' : 'false'}>
            <Stack gap="xs">
              {results.map((r) => (
                <Group key={r.name} gap="xs">
                  <Badge color={r.ok ? 'green' : 'red'} data-testid={`step-${r.name}`}>
                    {r.ok ? 'PASS' : 'FAIL'}
                  </Badge>
                  <Text fw={600}>{r.name}</Text>
                  <Text size="sm" c="dimmed">
                    {r.detail}
                  </Text>
                </Group>
              ))}
            </Stack>
          </Card>
        )}
      </Stack>
    </Container>
  );
}
