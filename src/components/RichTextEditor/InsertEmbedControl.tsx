import { Alert, Button, Group, Loader, Modal, Stack, Text, Textarea } from '@mantine/core';
import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconCode } from '@tabler/icons-react';
import type { Editor } from '@tiptap/core';
import { useEffect, useMemo, useState } from 'react';
import { ConsentBlockedEmbed } from '~/components/Consent/ConsentBlockedEmbed';
import { useThirdPartyConsent } from '~/components/Consent/consent.context';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { embedIframeAttrs } from '~/shared/tiptap/embed.node';
import type { EmbedProvider, ParsedEmbed } from '~/shared/utils/embed-providers';
import {
  EMBED_PROVIDER_LABELS,
  isAllowedPlayerUrl,
  parseEmbedUrl,
} from '~/shared/utils/embed-providers';
import { isValidURL } from '~/utils/type-guards';
import { trpc } from '~/utils/trpc';

const controlTitle = 'Embed a link';

// The legacy kinds insert through their own nodes, which only some editors register (StrawPoll
// needs `polls`). Detection is limited to what this editor can hold.
const LEGACY_NODE = { youtube: 'youtube', instagram: 'instagram', strawpoll: 'strawPoll' } as const;

function detectFor(editor: Editor, input: string): ParsedEmbed | null {
  const parsed = parseEmbedUrl(input);
  if (!parsed) return null;
  const node =
    parsed.kind in LEGACY_NODE ? LEGACY_NODE[parsed.kind as keyof typeof LEGACY_NODE] : 'embed';
  return editor.schema.nodes[node] ? parsed : null;
}

export function InsertEmbedControl(props: Props) {
  const { editor } = useRichTextEditorContext();

  return (
    <RichTextEditor.Control
      {...props}
      onClick={() => {
        if (editor) dialogStore.trigger({ component: EmbedUrlModal, props: { editor } });
      }}
      aria-label={controlTitle}
      title={controlTitle}
    >
      <IconCode size={16} stroke={1.5} />
    </RichTextEditor.Control>
  );
}

type Props = Omit<RichTextEditorControlProps, 'icon' | 'onClick'>;

function EmbedUrlModal({ editor }: { editor: Editor }) {
  const dialog = useDialogContext();
  const [value, setValue] = useState('');
  const detected = useMemo(() => detectFor(editor, value), [editor, value]);
  const lookup = trpc.content.resolveBandcampEmbed.useMutation();
  const bandcampPage = detected?.kind === 'bandcamp-lookup' ? detected.pageUrl : null;

  useEffect(() => {
    if (bandcampPage) lookup.mutate({ url: bandcampPage });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandcampPage]);

  const player: { provider: EmbedProvider; src: string } | null = (() => {
    if (detected?.kind === 'embed') return { provider: detected.provider, src: detected.playerUrl };
    if (bandcampPage && lookup.data?.ok && lookup.variables?.url === bandcampPage)
      return { provider: 'bandcamp', src: lookup.data.playerUrl };
    return null;
  })();
  const lookupFailed =
    !!bandcampPage && (lookup.isError || lookup.data?.ok === false) && !lookup.isPending;
  const linkUrl = value.trim();
  const canLink = isValidURL(linkUrl.startsWith('http') ? linkUrl : `https://${linkUrl}`);

  const insert = () => {
    const chain = editor.chain().focus();
    if (player && isAllowedPlayerUrl(player.src)) chain.setEmbed({ src: player.src }).run();
    else if (detected?.kind === 'youtube') chain.setYoutubeVideo({ src: detected.url }).run();
    else if (detected?.kind === 'instagram') chain.setInstagramEmbed({ src: detected.url }).run();
    else if (detected?.kind === 'strawpoll') chain.setStrawPollEmbed({ src: detected.url }).run();
    else if (canLink) {
      const href = linkUrl.startsWith('http') ? linkUrl : `https://${linkUrl}`;
      chain
        .insertContent({
          type: 'text',
          text: linkUrl,
          marks: editor.schema.marks.link ? [{ type: 'link', attrs: { href } }] : undefined,
        })
        .run();
    } else return;
    dialog.onClose();
  };

  const waiting = !!bandcampPage && lookup.isPending;
  const legacyLabel =
    detected && detected.kind !== 'embed' && detected.kind !== 'bandcamp-lookup'
      ? EMBED_PROVIDER_LABELS[detected.kind]
      : null;

  return (
    <Modal title={controlTitle} size="lg" {...dialog}>
      <Stack gap="sm">
        <Textarea
          label="Link or embed code"
          description="YouTube, Vimeo, Twitch, Spotify, SoundCloud, Bandcamp, Instagram, Hugging Face Spaces. Any other link is inserted as a normal link."
          placeholder="https://vimeo.com/76979871"
          autosize
          minRows={1}
          maxRows={4}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          data-autofocus
        />
        {value.trim() && (
          <EmbedStatus
            player={player}
            legacyLabel={legacyLabel}
            waiting={waiting}
            lookupFailed={lookupFailed}
            canLink={canLink}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button onClick={insert} disabled={waiting || (!player && !legacyLabel && !canLink)}>
            {player || legacyLabel ? 'Embed' : 'Insert link'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function EmbedStatus({
  player,
  legacyLabel,
  waiting,
  lookupFailed,
  canLink,
}: {
  player: { provider: EmbedProvider; src: string } | null;
  legacyLabel: string | null;
  waiting: boolean;
  lookupFailed: boolean;
  canLink: boolean;
}) {
  if (waiting)
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm">Looking up the Bandcamp player…</Text>
      </Group>
    );
  if (player)
    return (
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Detected: {EMBED_PROVIDER_LABELS[player.provider]}
        </Text>
        <EmbedPreview provider={player.provider} src={player.src} />
      </Stack>
    );
  if (legacyLabel)
    return (
      <Text size="sm" fw={600}>
        Detected: {legacyLabel}
      </Text>
    );
  if (lookupFailed)
    return (
      <Alert color="yellow" p="xs">
        Bandcamp didn&apos;t answer. On the track page use Share → Embed and paste that code here.
      </Alert>
    );
  return (
    <Text size="sm" c="dimmed">
      {canLink
        ? 'Not an embeddable link. It will be inserted as a normal link.'
        : 'Not a link we can insert.'}
    </Text>
  );
}

function EmbedPreview({ provider, src }: { provider: EmbedProvider; src: string }) {
  const { allowed } = useThirdPartyConsent();
  if (!allowed) return <ConsentBlockedEmbed kind={provider} />;
  const { allowfullscreen, ...attrs } = embedIframeAttrs(provider, src, window.location.hostname);
  return <iframe {...attrs} allowFullScreen={!!allowfullscreen} className="rounded border-0" />;
}
