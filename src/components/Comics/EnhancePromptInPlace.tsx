import { Button, Group, Switch, Text } from '@mantine/core';
import { IconWand } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';

export type EnhancePromptInPlaceProps = {
  /** Current prompt value */
  prompt: string;
  /** Callback to update the prompt text */
  setPrompt: (val: string) => void;
  /** Buzz cost for enhancement (null while loading) */
  enhanceCost: number | null;
  /** Show the "Use previous panel context" toggle */
  showContext?: boolean;
  /** Context toggle value */
  useContext?: boolean;
  /** Context toggle setter */
  setUseContext?: (val: boolean) => void;
  /** Project ID for the enhance endpoint */
  projectId: number;
  /** Chapter position for the enhance endpoint */
  chapterPosition: number;
  /** When inserting between panels, the position to insert at */
  insertAtPosition?: number | null;
  /** Called when the pending state changes — use to disable Generate buttons */
  onPendingChange?: (isPending: boolean) => void;
};

export function EnhancePromptInPlace({
  prompt,
  setPrompt,
  enhanceCost,
  showContext,
  useContext,
  setUseContext,
  projectId,
  chapterPosition,
  insertAtPosition,
  onPendingChange,
}: EnhancePromptInPlaceProps) {
  const [preEnhancePrompt, setPreEnhancePrompt] = useState<string | null>(null);

  const enhanceMutation = trpc.comics.enhancePromptText.useMutation({
    onSuccess: (data) => {
      setPreEnhancePrompt(prompt);
      setPrompt(data.enhancedPrompt);
    },
    onError: (err) => {
      showErrorNotification({
        error: new Error(err.message),
        title: 'Failed to enhance prompt',
      });
    },
  });

  const isPending = enhanceMutation.isPending;

  useEffect(() => {
    onPendingChange?.(isPending);
    return () => onPendingChange?.(false);
  }, [isPending, onPendingChange]);

  const handleEnhance = useCallback(() => {
    if (!prompt.trim() || enhanceMutation.isPending) return;
    enhanceMutation.mutate({
      projectId,
      chapterPosition,
      prompt: prompt.trim(),
      useContext: useContext ?? false,
      insertAtPosition: insertAtPosition ?? undefined,
    });
  }, [prompt, enhanceMutation, projectId, chapterPosition, useContext, insertAtPosition]);

  const handleRevert = useCallback(() => {
    if (preEnhancePrompt != null) {
      setPrompt(preEnhancePrompt);
      setPreEnhancePrompt(null);
    }
  }, [preEnhancePrompt, setPrompt]);

  const isEnhanced = preEnhancePrompt != null;

  return (
    <div className="flex flex-col gap-2 rounded border border-solid border-gray-600 p-3">
      <Group gap="xs" align="center">
        <BuzzTransactionButton
          buzzAmount={enhanceCost ?? 0}
          label={
            <span className="flex items-center gap-1">
              <IconWand size={14} />
              {isPending ? 'Enhancing...' : 'Enhance Prompt'}
            </span>
          }
          loading={isPending}
          disabled={!prompt.trim() || enhanceCost == null}
          onPerformTransaction={handleEnhance}
          showPurchaseModal
          size="xs"
        />
        {isEnhanced && (
          <Button size="xs" variant="subtle" color="gray" onClick={handleRevert}>
            Revert
          </Button>
        )}
      </Group>
      {isEnhanced && (
        <Text size="xs" c="yellow" style={{ fontStyle: 'italic' }}>
          Prompt enhanced — review and edit before generating
        </Text>
      )}
      {showContext && (
        <Switch
          size="xs"
          label="Use previous panel context"
          description="Include the previous panel's context when enhancing for continuity"
          checked={useContext}
          onChange={(e) => setUseContext?.(e.currentTarget.checked)}
        />
      )}
      <Text size="xs" c="dimmed">
        AI rewrites your prompt with more detail. Review the result before generating.
      </Text>
    </div>
  );
}
