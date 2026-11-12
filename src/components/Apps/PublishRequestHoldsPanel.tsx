import { Alert, Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconHandStop, IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import {
  ReasonGatedField,
  ReasonGatedSubmitButton,
  reasonMeetsMin,
} from '~/components/Apps/ReasonGatedActionModal';
import { compactRelativeTime, useNowTick } from '~/components/Apps/reviewRelativeTime';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  HOLD_LABEL_MAX,
  HOLD_REASON_MAX,
  HOLD_REASON_MIN,
  type PublishRequestHoldKind,
} from '~/shared/constants/publish-request-holds.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** The app's open review holds. An approve while any is open needs an override reason. */
export function useOpenPublishRequestHolds(slug: string | null | undefined) {
  const query = trpc.blocks.listPublishRequestHolds.useQuery(
    { slugs: slug ? [slug] : [] },
    { enabled: !!slug }
  );
  return query.data ?? [];
}

/** Approve is allowed with no open holds, or with an override reason of the minimum length. */
export function holdOverrideSatisfied(openHoldCount: number, overrideReason: string): boolean {
  return openHoldCount === 0 || reasonMeetsMin(overrideReason, HOLD_REASON_MIN);
}

type Hold = ReturnType<typeof useOpenPublishRequestHolds>[number];

export function PublishRequestHoldsPanel({
  slug,
  publishRequestId,
  kind,
  holds,
  overrideReason,
  onOverrideReasonChange,
  disabled,
}: {
  slug: string;
  publishRequestId: string;
  kind: PublishRequestHoldKind;
  holds: Hold[];
  overrideReason: string;
  onOverrideReasonChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Stack gap="xs" data-testid="apps-review-holds">
      {holds.length > 0 && (
        <Alert
          color="orange"
          variant="light"
          icon={<IconHandStop size={16} />}
          title={`${holds.length} open review hold${holds.length === 1 ? '' : 's'}`}
          data-testid="apps-review-holds-open"
        >
          <Stack gap="sm">
            {holds.map((h) => (
              <HoldRow key={h.id} hold={h} slug={slug} disabled={disabled} />
            ))}
            <ReasonGatedField
              value={overrideReason}
              onChange={onOverrideReasonChange}
              disabled={disabled}
              minLength={HOLD_REASON_MIN}
              maxLength={HOLD_REASON_MAX}
              label="Override reason (required to approve while holds are open)"
              placeholder="Why it is safe to approve despite these holds. Recorded on each hold; not shown to the developer."
              testId="apps-review-hold-override-reason"
              minRows={2}
              maxRows={6}
            />
          </Stack>
        </Alert>
      )}
      {adding ? (
        <AddHoldForm
          slug={slug}
          publishRequestId={publishRequestId}
          kind={kind}
          onDone={() => setAdding(false)}
        />
      ) : (
        <Group justify="flex-start">
          <Button
            size="compact-xs"
            variant="subtle"
            color="orange"
            leftSection={<IconPlus size={12} />}
            onClick={() => setAdding(true)}
            disabled={disabled}
            data-testid="apps-review-hold-add"
          >
            Place a hold
          </Button>
        </Group>
      )}
    </Stack>
  );
}

function HoldRow({ hold, slug, disabled }: { hold: Hold; slug: string; disabled?: boolean }) {
  const utils = trpc.useUtils();
  const now = useNowTick();
  const [clearing, setClearing] = useState(false);
  const [reason, setReason] = useState('');
  const clearMut = trpc.blocks.clearPublishRequestHold.useMutation({
    onSuccess: async () => {
      setClearing(false);
      await invalidateHolds(utils, slug);
    },
    onError: (err) => showErrorNotification({ title: 'Could not clear hold', error: err }),
  });
  return (
    <Stack gap={4} data-testid={`apps-review-hold-${hold.id}`}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="sm" fw={600}>
          {hold.placedByLabel}{' '}
          <Text span size="xs" c="dimmed" fw={400}>
            {hold.placedByUsername ?? `user ${hold.placedByUserId}`} ·{' '}
            {compactRelativeTime(new Date(hold.createdAt), now)}
          </Text>
        </Text>
        {!clearing && (
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => setClearing(true)}
            disabled={disabled}
          >
            Clear
          </Button>
        )}
      </Group>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        {hold.reason}
      </Text>
      {clearing && (
        <Stack gap={4}>
          <ReasonGatedField
            value={reason}
            onChange={setReason}
            minLength={HOLD_REASON_MIN}
            maxLength={HOLD_REASON_MAX}
            label="Why is this hold cleared?"
            testId={`apps-review-hold-clear-reason-${hold.id}`}
            minRows={2}
          />
          <Group justify="flex-end" gap="xs">
            <Button size="xs" variant="default" onClick={() => setClearing(false)}>
              Cancel
            </Button>
            <ReasonGatedSubmitButton
              onClick={() => clearMut.mutate({ holdId: hold.id, reason: reason.trim() })}
              gateOpen={reasonMeetsMin(reason, HOLD_REASON_MIN)}
              busy={clearMut.isPending}
              label="Clear hold"
              testId={`apps-review-hold-clear-confirm-${hold.id}`}
            />
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

function AddHoldForm({
  slug,
  publishRequestId,
  kind,
  onDone,
}: {
  slug: string;
  publishRequestId: string;
  kind: PublishRequestHoldKind;
  onDone: () => void;
}) {
  const utils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const [label, setLabel] = useState(currentUser?.username ?? '');
  const [reason, setReason] = useState('');
  const placeMut = trpc.blocks.placePublishRequestHold.useMutation({
    onSuccess: async () => {
      onDone();
      await invalidateHolds(utils, slug);
    },
    onError: (err) => showErrorNotification({ title: 'Could not place hold', error: err }),
  });
  return (
    <Stack gap={4} data-testid="apps-review-hold-form">
      <TextInput
        label="Label"
        description="Who or which check holds it"
        value={label}
        maxLength={HOLD_LABEL_MAX}
        onChange={(e) => setLabel(e.currentTarget.value)}
      />
      <ReasonGatedField
        value={reason}
        onChange={setReason}
        minLength={HOLD_REASON_MIN}
        maxLength={HOLD_REASON_MAX}
        label="What must happen before this can be approved?"
        testId="apps-review-hold-reason"
        minRows={2}
      />
      <Group justify="flex-end" gap="xs">
        <Button size="xs" variant="default" onClick={onDone}>
          Cancel
        </Button>
        <ReasonGatedSubmitButton
          onClick={() =>
            placeMut.mutate({ publishRequestId, kind, label: label.trim(), reason: reason.trim() })
          }
          gateOpen={label.trim().length > 0 && reasonMeetsMin(reason, HOLD_REASON_MIN)}
          busy={placeMut.isPending}
          color="orange"
          label="Place hold"
          testId="apps-review-hold-place"
        />
      </Group>
    </Stack>
  );
}

async function invalidateHolds(utils: ReturnType<typeof trpc.useUtils>, slug: string) {
  await Promise.all([
    utils.blocks.listPublishRequestHolds.invalidate({ slugs: [slug] }),
    utils.blocks.listPendingRequests.invalidate(),
    utils.appListings.listPendingRequests.invalidate(),
  ]);
}
