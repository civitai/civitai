import { Alert, Anchor, Button, Group, Stack, Text } from '@mantine/core';
import { IconPlugConnected, IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { openConfirmModal } from '@mantine/modals';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

interface Props {
  modelId: number;
  modelType: string;
}

/**
 * Banner shown on the model edit page when one or more of the current
 * user's `publisher_all_my_models` subscriptions targets this model.
 * Lets them either jump to the subscription's settings or opt out
 * for this specific model (by writing a per-model install row with
 * enabled=false; the NOT EXISTS clause in listForModel picks it up).
 */
export function PublisherSubscriptionBanner({ modelId, modelType }: Props) {
  const features = useFeatureFlags();
  const utils = trpc.useUtils();
  const { data: subs } = trpc.blocks.listMySubscriptions.useQuery(undefined, {
    enabled: !!features.appBlocks,
  });

  // Filter to subscriptions that would actually affect this model.
  // publisher_all_my_models scope with no targets, or targets that
  // include the model's type. (Base-model filtering happens server-side
  // in listForModel; here we conservatively show the banner when the
  // model-type filter passes, since checking baseModel requires an
  // extra ModelVersion lookup the banner doesn't need to be exact about.)
  const matching = (subs ?? []).filter((sub) => {
    if (sub.scope !== 'publisher_all_my_models') return false;
    if (!sub.enabled) return false;
    if (sub.targetModelTypes && sub.targetModelTypes.length > 0) {
      if (!sub.targetModelTypes.includes(modelType)) return false;
    }
    return true;
  });

  // Opt out: write a per-model install row with enabled=false. The
  // existing installOnModel route runs the per-block-id settings parse
  // and then we toggle the row off. blocks.installOnModel handles the
  // upsert path, so this is one network round-trip.
  const installMutation = trpc.blocks.installOnModel.useMutation();
  const toggleMutation = trpc.blocks.toggleEnabled.useMutation({
    onSuccess: async () => {
      await utils.blocks.listForModel.invalidate();
      showSuccessNotification({
        title: 'Disabled',
        message: 'The block won\'t show on this model anymore.',
      });
    },
    onError: (e) =>
      showErrorNotification({ title: 'Could not disable', error: new Error(e.message) }),
  });

  async function handleDisableForModel(appBlockId: string) {
    // Heuristic: each block's manifest declares which slots it targets.
    // The subscription doesn't carry slot in v1 because a block usually
    // targets one slot; we read the slot off the manifest.targets[0].
    const sub = matching.find((s) => s.appBlockId === appBlockId);
    if (!sub) return;
    const slotId = sub.manifest.targets?.[0]?.slotId;
    if (!slotId) return;
    try {
      const installed = await installMutation.mutateAsync({
        modelId,
        appBlockId,
        slotId: slotId as 'model.sidebar_top' | 'model.below_images' | 'model.actions_extra',
      });
      await toggleMutation.mutateAsync({
        blockInstanceId: installed.blockInstanceId,
        enabled: false,
      });
    } catch (err) {
      showErrorNotification({
        title: 'Could not disable',
        error: err instanceof Error ? err : new Error('Unknown error'),
      });
    }
  }

  if (!features.appBlocks || matching.length === 0) return null;

  return (
    <Alert
      icon={<IconPlugConnected size={18} />}
      color="blue"
      variant="light"
      title="Subscribed blocks affecting this model"
    >
      <Stack gap="xs">
        <Text size="sm">
          These blocks show on this model via your &quot;On all my models&quot; subscriptions.
        </Text>
        {matching.map((sub) => (
          <Group key={sub.id} justify="space-between" wrap="nowrap">
            <Text size="sm" fw={500}>
              {sub.manifest.name ?? sub.blockId}
            </Text>
            <Group gap={6}>
              <Anchor component={Link} href="/apps/installed" size="xs">
                Edit subscription
              </Anchor>
              <Button
                size="xs"
                variant="default"
                leftSection={<IconX size={12} />}
                loading={installMutation.isPending || toggleMutation.isPending}
                onClick={() =>
                  openConfirmModal({
                    title: `Disable "${sub.manifest.name ?? sub.blockId}" for this model only?`,
                    children: (
                      <Text size="sm">
                        The block will still show on your other models. You can re-enable it
                        anytime by removing the per-model opt-out.
                      </Text>
                    ),
                    labels: { confirm: 'Disable for this model', cancel: 'Cancel' },
                    confirmProps: { color: 'red' },
                    onConfirm: () => handleDisableForModel(sub.appBlockId),
                  })
                }
              >
                Disable for this model only
              </Button>
            </Group>
          </Group>
        ))}
      </Stack>
    </Alert>
  );
}
