import { Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertCircle, IconAlertTriangle, IconDice5, IconRefresh } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '~/server/routers';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { parsePromptSnippetReferences } from '~/utils/prompt-helpers';
import { trpc } from '~/utils/trpc';

export type WildcardPreviewTarget = {
  /** Snippet target key as it appears in `snippets.targets` (e.g. 'prompt'). */
  key: string;
  /** Human-readable label for the target section header. */
  label: string;
  /** Current editor value — the template the resolver expands. */
  text: string;
};

export type WildcardPreviewModalProps = {
  wildcardSetIds: number[];
  targets: WildcardPreviewTarget[];
  /**
   * Current `snippets.seed` from form state, if any. When set, the modal's
   * first request reuses this seed instead of letting the server sample
   * a new one — re-opening after OK shows the exact same resolution the
   * user previously committed to. Regenerate always omits the seed and
   * lets the server sample a fresh one.
   */
  initialSeed?: number;
  /**
   * Commit the modal's current seed to form state. Called when the user
   * clicks OK (not on every preview/regenerate) so closing without
   * confirming leaves the editor footer unchanged. Submit clears it —
   * see GenerationForm's FormFooter.
   */
  onSeedChange?: (seed: number) => void;
};

/**
 * Modal that shows how the user's prompt(s) resolve once `#category` snippet
 * references are substituted by the server resolver. Mounted via the shared
 * dialog registry (see `openWildcardPreview` trigger) so it can live outside
 * the form's DataGraphProvider — props carry everything it needs.
 *
 * Fires `wildcardSet.previewExpansion` once on mount with no seed (server
 * samples a fresh one and echoes it back), and again on every Regenerate
 * click. Regenerate omits the seed so the server samples a new one — clearing
 * any stale seed in the same path. Highlighting of substituted spans is
 * computed client-side by zip-walking the original template against the
 * resolved text, anchored on the literal segments between `#refs`.
 */
export default function WildcardPreviewModal({
  wildcardSetIds,
  targets,
  initialSeed,
  onSeedChange,
}: WildcardPreviewModalProps) {
  const dialog = useDialogContext();

  // The server takes a `targets` record keyed by name with the template
  // value. We snapshot the props' targets into that shape once per mutation
  // call — the modal owns no mutable state of its own.
  const targetMap = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const t of targets) out[t.key] = t.text;
    return out;
  }, [targets]);

  // Mirror the mutation result into local state. We don't read off
  // `preview.data` / `preview.isLoading` directly because, in dev with
  // React 18 StrictMode, the modal's mount→unmount→remount can leave the
  // mutation hook subscribed to an orphaned in-flight mutation that never
  // updates state — leaving `status: 'loading'` forever even after the
  // network request returns. The `onSuccess` / `onError` callbacks fire
  // reliably on response, so committing the result to local state here
  // sidesteps that quirk entirely.
  type PreviewData = inferRouterOutputs<AppRouter>['wildcardSet']['previewExpansion'];
  const [data, setData] = useState<PreviewData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const preview = trpc.wildcardSet.previewExpansion.useMutation({
    onSuccess: (result) => {
      setData(result);
      setIsLoading(false);
      setError(null);
    },
    onError: (err) => {
      setError(err.message);
      setIsLoading(false);
    },
  });

  // Auto-fire once on mount. The ref-guard keeps StrictMode's double-invoke
  // from double-firing the mutation in dev. When the caller passes an
  // `initialSeed` (form already has a committed seed from a prior OK), use
  // it so the user sees the same resolution they last committed to.
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    preview.mutate({
      wildcardSetIds,
      targets: targetMap,
      ...(initialSeed !== undefined ? { seed: initialSeed } : {}),
    });
  }, [preview, wildcardSetIds, targetMap, initialSeed]);

  const handleRegenerate = () => {
    // No seed → server samples a fresh one for display. Nothing is written
    // to form state until the user clicks OK below.
    setIsLoading(true);
    preview.mutate({ wildcardSetIds, targets: targetMap });
  };

  const handleOk = () => {
    // Commit the currently-displayed seed to form state, then close. The
    // editor footer will reflect the new seed via `onSeedChange` (which
    // writes `snippets.seed` in the graph). Submit clears it.
    if (data?.seed !== undefined) onSeedChange?.(data.seed);
    dialog.onClose();
  };

  return (
    <Modal {...dialog} size="lg" title="Preview" padding="lg">
      <Stack gap="md">
        {/* Header row — seed pill + regenerate */}
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <IconDice5 size={16} className="text-blue-4" />
            <Text size="sm" c="dimmed">
              Seed
            </Text>
            <Text size="sm" ff="monospace" fw={600} c="bright">
              {data?.seed ?? (isLoading ? '…' : '—')}
            </Text>
          </Group>
          <Button
            variant="filled"
            color="blue"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            onClick={handleRegenerate}
            loading={isLoading}
            disabled={!data && isLoading}
          >
            Regenerate
          </Button>
        </Group>

        {/* Per-target expanded preview. Loading state shares the same column
            structure so the modal doesn't reflow when the first response lands. */}
        {error ? (
          <Alert color="red" icon={<IconAlertCircle size={16} />}>
            {error}
          </Alert>
        ) : (
          <Stack gap="md">
            {targets.map((target) => {
              const resolved = data?.targets[target.key];
              return (
                <div key={target.key}>
                  <Group gap="xs" mb={6}>
                    <span className="size-1.5 rounded-full bg-blue-5" aria-hidden />
                    <Text size="sm" fw={600}>
                      {target.label}
                    </Text>
                  </Group>
                  <div className="whitespace-pre-wrap break-words rounded-md border border-dark-4 bg-dark-7 px-4 py-3 text-sm leading-relaxed text-gray-2">
                    {resolved !== undefined ? (
                      <ResolvedText original={target.text} resolved={resolved} />
                    ) : (
                      <Group gap="xs">
                        <Loader size="xs" />
                        <Text size="xs" c="dimmed">
                          Resolving…
                        </Text>
                      </Group>
                    )}
                  </div>
                </div>
              );
            })}
          </Stack>
        )}

        {/* Unresolved-ref warning. Emitted by the resolver when a `#ref` in
            the template has no matching category in any loaded set (or every
            matching category got filtered out by NSFW gating). The resolver
            substitutes the literal `#name` in that case; we surface it so the
            user knows the chip won't fan out. */}
        {data?.diagnostics.unresolved.length ? (
          <Alert
            color="yellow"
            icon={<IconAlertTriangle size={16} />}
            title="Some references couldn't be resolved"
            variant="light"
          >
            <Group gap={6} mt={4}>
              {data.diagnostics.unresolved.map((ref) => (
                <span
                  key={ref}
                  className="font-mono rounded bg-dark-5 px-1.5 py-0.5 text-xs text-blue-3"
                >
                  #{ref}
                </span>
              ))}
            </Group>
            <Text size="xs" c="dimmed" mt={6}>
              No values from your loaded wildcard sets matched — they&apos;ll appear in the prompt
              literally.
            </Text>
          </Alert>
        ) : null}

        <Group justify="flex-end" mt={4} gap="xs">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button
            variant="filled"
            color="blue"
            onClick={handleOk}
            disabled={data?.seed === undefined}
          >
            OK
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * Render the resolved text with substituted phrases highlighted. Walks the
 * original template's literal-vs-`#ref` segments and finds each literal as an
 * anchor in the resolved string; everything between anchors is whatever the
 * resolver substituted for that ref. Falls back to plain rendering if the
 * walker can't find an anchor (unresolved-ref edge case, or substituted
 * value happens to contain a verbatim copy of an adjacent literal).
 */
function ResolvedText({ original, resolved }: { original: string; resolved: string }) {
  const segments = useMemo(
    () => computeHighlightedSegments(original, resolved),
    [original, resolved]
  );
  return (
    <span>
      {segments.map((seg, i) =>
        seg.highlighted ? (
          <span key={i} className="rounded bg-green-9/25 px-1 font-medium text-green-2">
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </span>
  );
}

type HighlightSegment = { text: string; highlighted: boolean };

export function computeHighlightedSegments(original: string, resolved: string): HighlightSegment[] {
  const refs = parsePromptSnippetReferences(original);
  if (refs.length === 0) return [{ text: resolved, highlighted: false }];

  // Build an alternating list of literal vs ref segments from the original.
  type Seg = { kind: 'literal' | 'ref'; text: string };
  const segs: Seg[] = [];
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start > cursor) {
      segs.push({ kind: 'literal', text: original.slice(cursor, ref.start) });
    }
    segs.push({ kind: 'ref', text: original.slice(ref.start, ref.end) });
    cursor = ref.end;
  }
  if (cursor < original.length) {
    segs.push({ kind: 'literal', text: original.slice(cursor) });
  }

  const out: HighlightSegment[] = [];
  let rCursor = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.kind === 'literal') {
      // Literals pass through the resolver byte-identically. Expect them at
      // rCursor; if we drift (unlikely), emit anything in between as a
      // highlighted span and re-anchor.
      const idx = resolved.indexOf(seg.text, rCursor);
      if (idx < 0) {
        // Anchor lost — emit rest as plain text and bail.
        if (rCursor < resolved.length) {
          out.push({ text: resolved.slice(rCursor), highlighted: false });
        }
        return out;
      }
      if (idx > rCursor) {
        out.push({ text: resolved.slice(rCursor, idx), highlighted: true });
      }
      out.push({ text: seg.text, highlighted: false });
      rCursor = idx + seg.text.length;
    } else {
      // Ref segment — find the next literal anchor (or end-of-string) and
      // grab everything up to it as the substituted span.
      const nextLiteral = segs[i + 1];
      if (!nextLiteral) {
        if (rCursor < resolved.length) {
          out.push({ text: resolved.slice(rCursor), highlighted: true });
          rCursor = resolved.length;
        }
      } else {
        const nextIdx = resolved.indexOf(nextLiteral.text, rCursor);
        if (nextIdx < 0) {
          out.push({ text: resolved.slice(rCursor), highlighted: true });
          rCursor = resolved.length;
        } else if (nextIdx > rCursor) {
          out.push({ text: resolved.slice(rCursor, nextIdx), highlighted: true });
          rCursor = nextIdx;
        }
        // nextIdx === rCursor → empty substitution; nothing to emit, the
        // next literal-segment iteration will pick it up.
      }
    }
  }
  return out;
}
