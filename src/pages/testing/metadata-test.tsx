import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Container,
  Group,
  Image,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconPhoto, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import type { MediaMetadata, ParserPlugin } from '@civitai/generation-metadata';
/* eslint-disable no-restricted-imports -- this page's plugin toggles need the bare reader */
import {
  applyPlugins,
  copyMetadata,
  defaultParsers,
  encodeMetadata as encodePackageMetadata,
  readMetadata,
} from '@civitai/generation-metadata';
/* eslint-enable no-restricted-imports */
import { civitai } from '@civitai/generation-metadata/civitai';
import { isProd } from '~/env/other';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { imageMetaSchema } from '~/server/schema/image.schema';
import { auditMetaData } from '~/utils/metadata/audit';
import { isAndroidDevice } from '~/utils/device-helpers';

/**
 * Drop-in metadata inspector in the style of the @civitai/generation-metadata
 * playground: multiple images (drop / paste / URL), plugin toggle with
 * bare-core comparison, the package's full envelope per image, plus the two
 * app-only layers (imageMetaSchema shape, prompt audit) and a canvas
 * resize/convert round-trip through copyMetadata.
 */

type Entry = {
  id: number;
  name: string;
  bytes: Uint8Array;
  objectUrl: string;
  md: MediaMetadata;
  bareDiff?: string[];
  sourceDiff?: string[];
  sourceRaw?: Record<string, unknown>;
};

let nextId = 1;

function metaDiff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

function describeExif(exif: Readonly<Record<string, unknown>>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(exif)) {
    if (value instanceof Uint8Array) out[key] = `<${value.length} bytes>`;
    else if (typeof value === 'string' && value.length > 2000)
      out[key] = value.slice(0, 2000) + `… (${value.length} chars)`;
    else out[key] = value;
  }
  return out;
}

function Section({ title, children, open }: { title: string; children: string; open?: boolean }) {
  return (
    <details open={open}>
      <summary className="cursor-pointer select-none text-sm font-medium opacity-80">
        {title}
      </summary>
      <pre className="mt-1 max-h-96 overflow-auto rounded bg-gray-1 p-2 text-xs dark:bg-dark-8">
        {children}
      </pre>
    </details>
  );
}

export default function MetadataTester() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [usePlugins, setUsePlugins] = useState(true);
  const [compare, setCompare] = useState(false);
  const [nsfw, setNsfw] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string>();
  const optionsRef = useRef({ usePlugins, compare });
  optionsRef.current = { usePlugins, compare };

  function currentPlugins(): ParserPlugin[] {
    return optionsRef.current.usePlugins ? [civitai()] : [];
  }

  async function addBytes(name: string, bytes: Uint8Array, extra?: Partial<Entry>) {
    try {
      const plugins = currentPlugins();
      const md = await readMetadata(bytes, { plugins });
      let bareDiff: string[] | undefined;
      if (optionsRef.current.compare && plugins.length > 0) {
        const bare = await readMetadata(bytes);
        bareDiff = metaDiff(bare.raw, md.raw as Record<string, unknown>);
      }
      const entry: Entry = {
        id: nextId++,
        name,
        bytes,
        objectUrl: URL.createObjectURL(new Blob([bytes as BlobPart])),
        md,
        bareDiff,
        ...extra,
      };
      setEntries((prev) => [entry, ...prev]);
      setError(undefined);
    } catch (e) {
      setError(`${name}: ${String(e)}`);
    }
  }

  async function addFiles(files: Iterable<File>) {
    for (const file of files) {
      await addBytes(file.name, new Uint8Array(await file.arrayBuffer()));
    }
  }

  async function addUrl(target: string) {
    try {
      const res = await fetch(target);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await addBytes(target.split('/').pop() ?? target, new Uint8Array(await res.arrayBuffer()));
    } catch (e) {
      setError(`${target}: ${String(e)}`);
    }
  }

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) void addFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isProd) return null;

  return (
    <Container size="md" py="xl">
      <Stack>
        <Title>Metadata Inspector</Title>
        <Group>
          <Switch
            checked={usePlugins}
            onChange={(e) => setUsePlugins(e.currentTarget.checked)}
            label="civitai plugin"
          />
          <Switch
            checked={compare}
            onChange={(e) => setCompare(e.currentTarget.checked)}
            label="compare vs bare core"
            disabled={!usePlugins}
          />
          <Switch
            checked={nsfw}
            onChange={(e) => setNsfw(e.currentTarget.checked)}
            label="NSFW audit"
          />
        </Group>
        <Text size="sm" c="dimmed">
          Supported parsers:{' '}
          {[
            ...new Set(
              applyPlugins(usePlugins ? [civitai()] : [], defaultParsers).parsers.map(
                (p) => p.generator
              )
            ),
          ].join(', ')}{' '}
          · reads png / jpeg / webp · writes png / jpeg. Anything else shows “no generator
          detected”.
        </Text>
        <Dropzone
          onDrop={(files) => void addFiles(files)}
          accept={IMAGE_MIME_TYPE}
          maxSize={50 * 1024 ** 2}
          useFsAccessApi={!isAndroidDevice()}
        >
          <Group justify="center" gap="xl" mih={100} style={{ pointerEvents: 'none' }}>
            <Dropzone.Accept>
              <IconUpload size={40} stroke={1.5} />
            </Dropzone.Accept>
            <Dropzone.Reject>
              <IconX size={40} stroke={1.5} />
            </Dropzone.Reject>
            <Dropzone.Idle>
              <IconPhoto size={40} stroke={1.5} />
            </Dropzone.Idle>
            <div>
              <Text size="lg" inline>
                Drop images here, click to select, or paste from clipboard
              </Text>
              <Text size="sm" c="dimmed" mt={4}>
                Multiple files welcome — each gets its own card, newest first
              </Text>
            </div>
          </Group>
        </Dropzone>
        <Group align="end" gap="xs">
          <TextInput
            label="Or fetch a URL (use original=true for civitai CDN images)"
            placeholder="https://image.civitai.com/…/original=true/….jpeg"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && url) void addUrl(url.trim());
            }}
            className="grow"
          />
          <Button onClick={() => url && void addUrl(url.trim())}>Fetch</Button>
        </Group>
        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
        {entries.map((entry) => (
          <EntryCard
            key={entry.id}
            entry={entry}
            nsfw={nsfw}
            onTransformed={addBytes}
            onRemove={() =>
              setEntries((prev) => {
                URL.revokeObjectURL(entry.objectUrl);
                return prev.filter((e) => e.id !== entry.id);
              })
            }
          />
        ))}
      </Stack>
    </Container>
  );
}

function EntryCard({
  entry,
  nsfw,
  onTransformed,
  onRemove,
}: {
  entry: Entry;
  nsfw: boolean;
  onTransformed: (name: string, bytes: Uint8Array, extra?: Partial<Entry>) => Promise<void>;
  onRemove: () => void;
}) {
  const { name, bytes, objectUrl, md } = entry;
  const [width, setWidth] = useState<string | number>(512);
  const [format, setFormat] = useState<string | null>(md.format === 'jpeg' ? 'jpeg' : 'png');
  const [transforming, setTransforming] = useState(false);

  const rawKeys = Object.keys(md.raw).length;
  const exifKeys = Object.keys(md.exif).length;
  const appMeta = imageMetaSchema.safeParse(md.raw ?? {});
  const audit = auditMetaData(appMeta.success ? appMeta.data : undefined, nsfw);

  async function transform() {
    setTransforming(true);
    try {
      const targetWidth = Math.max(16, Number(width) || 512);
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(targetWidth, bitmap.width);
      canvas.height = Math.round(bitmap.height * (canvas.width / bitmap.width));
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, `image/${format}`, format === 'jpeg' ? 0.9 : undefined)
      );
      if (!blob) throw new Error('canvas.toBlob failed');
      const stripped = new Uint8Array(await blob.arrayBuffer());
      const restored = await copyMetadata(bytes, stripped);
      const restoredMd = await readMetadata(restored, { plugins: [civitai()] });
      await onTransformed(`${name} → ${canvas.width}px ${format}`, restored, {
        sourceRaw: md.raw as Record<string, unknown>,
        sourceDiff: metaDiff(md.raw, restoredMd.raw as Record<string, unknown>),
      });
    } finally {
      setTransforming(false);
    }
  }

  return (
    <Card withBorder>
      <Group align="start" wrap="nowrap">
        <Image src={objectUrl} alt={name} w={120} h={120} fit="contain" radius="sm" />
        <Stack gap="xs" className="min-w-0 grow">
          <Group gap="xs" wrap="nowrap">
            <Text fw={600} truncate>
              {name}
            </Text>
            <Text size="sm" c="dimmed" className="shrink-0">
              {(bytes.length / 1024).toFixed(0)} KB
            </Text>
            <ActionIcon variant="subtle" color="gray" ml="auto" onClick={onRemove}>
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
          <Group gap={6}>
            <Badge variant="light" color="gray">
              {md.format}
            </Badge>
            <Badge variant="light" color={md.generator ? 'blue' : 'red'}>
              {md.generator ?? 'no generator detected'}
            </Badge>
            {md.civitai?.madeOnSite && (
              <Badge variant="light" color="green">
                made on civitai
              </Badge>
            )}
            <Badge variant="light" color="gray">
              {rawKeys} meta key{rawKeys === 1 ? '' : 's'}
            </Badge>
            {exifKeys === 0 && (
              <Badge variant="light" color="red">
                no readable exif/text data
              </Badge>
            )}
            {!audit.success && (
              <Badge variant="light" color="red" title={audit.blockedFor.join(', ')}>
                audit: blocked
              </Badge>
            )}
            {entry.bareDiff && (
              <Badge variant="light" color={entry.bareDiff.length ? 'violet' : 'gray'}>
                plugin changed {entry.bareDiff.length} key{entry.bareDiff.length === 1 ? '' : 's'}
              </Badge>
            )}
            {entry.sourceDiff &&
              (entry.sourceDiff.length === 0 ? (
                <Badge variant="light" color="green">
                  metadata fully preserved
                </Badge>
              ) : (
                <Badge variant="light" color="red">
                  lossy: {entry.sourceDiff.length} key{entry.sourceDiff.length === 1 ? '' : 's'}{' '}
                  changed
                </Badge>
              ))}
          </Group>
        </Stack>
      </Group>
      <Stack gap={6} mt="sm">
        {/* Opens itself when no generator matched: the exif dump is how a user
            tells "unsupported format with readable data" from "no metadata" */}
        <Section
          title={`Source tags as read from the file (md.exif) — ${exifKeys} tag${
            exifKeys === 1 ? '' : 's'
          }`}
          open={!md.generator}
        >
          {exifKeys
            ? JSON.stringify(describeExif(md.exif), null, 2)
            : 'No readable exif / text-chunk metadata in this file.'}
        </Section>
        <Section title="Parsed metadata — raw parser output, before normalization (md.raw)" open>
          {JSON.stringify(md.raw, null, 2)}
        </Section>
        {md.civitai && (
          <Section
            title="civitai plugin namespace (md.civitai — madeOnSite, extra, normalized generation)"
            open
          >
            {JSON.stringify(md.civitai, null, 2)}
          </Section>
        )}
        <Section title="App meta (imageMetaSchema)">
          {appMeta.success
            ? JSON.stringify(appMeta.data, null, 2)
            : `schema rejected: ${appMeta.error.message}`}
        </Section>
        {!audit.success && <Section title="Audit result">{JSON.stringify(audit, null, 2)}</Section>}
        {md.generator && (
          <Section title={`Re-encoded ${md.generator} text`}>
            {encodePackageMetadata(md.raw, md.generator, { plugins: [civitai()] })}
          </Section>
        )}
        {entry.sourceDiff && entry.sourceDiff.length > 0 && entry.sourceRaw && (
          <Section title="Changed/lost keys vs source" open>
            {JSON.stringify(
              Object.fromEntries(
                entry.sourceDiff.map((k) => [k, { before: entry.sourceRaw![k], after: md.raw[k] }])
              ),
              null,
              2
            )}
          </Section>
        )}
      </Stack>
      <Group gap="xs" mt="sm" align="end">
        <Text size="sm" c="dimmed">
          Resize / convert (canvas strips metadata; copyMetadata restores it):
        </Text>
        <NumberInput value={width} onChange={setWidth} min={16} w={90} size="xs" />
        <Select
          value={format}
          onChange={setFormat}
          data={['png', 'jpeg']}
          w={90}
          size="xs"
          allowDeselect={false}
        />
        <Button size="xs" onClick={() => void transform()} loading={transforming}>
          Transform + copyMetadata
        </Button>
      </Group>
    </Card>
  );
}
