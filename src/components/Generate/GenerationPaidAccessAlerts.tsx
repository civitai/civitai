import { Button, Notification, Text } from '@mantine/core';
import { IconBolt, IconX } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { pickGateForMessage, type PurchaseGate } from '~/components/Generate/paid-access-gate';
import { useGenerationPurchaseGates } from '~/components/Generate/useGenerationPurchaseGates';
import { ModelVersionEarlyAccessPurchase } from '~/components/Model/ModelVersions/ModelVersionEarlyAccessPurchase';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

function GetAccessButton({ gate, label }: { gate: PurchaseGate; label: string }) {
  const features = useFeatureFlags();

  // The purchase path itself refuses when this is off, so link to the version instead of opening a
  // modal whose only outcome would be an "Unauthorized" notification.
  if (!features.earlyAccessModel)
    return (
      <Button
        component="a"
        href={`/models/${gate.modelId}?modelVersionId=${gate.modelVersionId}`}
        target="_blank"
        variant="light"
        color="yellow"
        radius="xl"
        size="compact-sm"
      >
        View model
      </Button>
    );

  return (
    <Button
      variant="light"
      color="yellow"
      radius="xl"
      size="compact-sm"
      leftSection={<IconBolt size={14} fill="currentColor" />}
      onClick={() =>
        dialogStore.trigger({
          component: ModelVersionEarlyAccessPurchase,
          props: { modelVersionId: gate.modelVersionId, reason: 'generation' },
        })
      }
    >
      {label}
    </Button>
  );
}

const priceLabel = (gate: PurchaseGate) =>
  gate.price != null ? `Get access — ${abbreviateNumber(gate.price)}` : 'Get access';

/**
 * Shown when the trial allowance blocks the job — spent, or short of the requested quantity. Replaces the
 * bare message, which named the model and offered nothing (CU 868maecz9).
 */
export function TrialBlockedAlert({
  message,
  remaining,
  onClose,
}: {
  message: string;
  /** From the message itself. Undefined means the count was not stated, which only happens at zero. */
  remaining?: number;
  /** Absent when the message came from the whatIf rather than a submit — there is no error to clear. */
  onClose?: () => void;
}) {
  const { gates } = useGenerationPurchaseGates();
  const gate = pickGateForMessage(gates, message);
  const offered = gate ? [gate] : gates;
  // A blocking message with trials LEFT is the quantity case: the allowance covers fewer images than were
  // asked for. Saying "used up" there is wrong, and it hides the free remedy — generate fewer.
  const blockedCopy =
    gate && remaining
      ? `Only ${remaining} free trial ${remaining === 1 ? 'generation' : 'generations'} left with ${
          gate.modelName
        }. Lower the quantity to ${remaining}, or purchase access to generate more at once.`
      : gate
      ? `Your free trial generations with ${gate.modelName} are used up. Purchase access to keep generating with it.`
      : message;

  return (
    <Notification
      icon={<IconX size={18} />}
      color="red"
      onClose={onClose}
      withCloseButton={!!onClose}
      className="whitespace-pre-wrap rounded-md bg-red-8/20"
    >
      <div className="flex w-full flex-wrap items-center justify-between gap-2">
        <Text size="sm">{blockedCopy}</Text>
        <div className="flex flex-wrap gap-2">
          {offered.map((option) => (
            <GetAccessButton
              key={option.modelVersionId}
              gate={option}
              label={offered.length > 1 ? `${option.modelName} — get access` : priceLabel(option)}
            />
          ))}
        </div>
      </div>
    </Notification>
  );
}

/**
 * The same offer, before the wall. Without it the first thing a non-buyer learns about a paid resource is
 * that its trial is gone — nothing else in the form says generations with it are finite.
 *
 * `remaining` comes from the orchestrator's whatIf warning when there is one. It is NOT dismissible while
 * a count is known: that number changes with every generation, so a dismissal taken at 5 left would hide
 * the one reading that matters at 1.
 */
export function TrialAccessWarning({ remaining }: { remaining?: number } = {}) {
  const { gates } = useGenerationPurchaseGates();
  if (!gates.length) return null;

  return (
    <>
      {gates.map((gate) => {
        const body =
          remaining != null
            ? `${remaining} free trial ${
                remaining === 1 ? 'generation' : 'generations'
              } left with ${gate.modelName}. Purchase access to keep generating with it after that.`
            : `${gate.modelName} is a paid resource. You get a limited number of free generations with it before purchase is required.`;

        const content = (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Text size="xs">{body}</Text>
            <GetAccessButton gate={gate} label={priceLabel(gate)} />
          </div>
        );

        return remaining != null ? (
          <DismissibleAlert
            key={gate.modelVersionId}
            color="yellow"
            size="sm"
            icon={<IconBolt size={18} fill="currentColor" />}
          >
            {content}
          </DismissibleAlert>
        ) : (
          <DismissibleAlert
            key={gate.modelVersionId}
            id={`gen-paid-access-${gate.modelVersionId}`}
            color="yellow"
            size="sm"
            icon={<IconBolt size={18} fill="currentColor" />}
          >
            {content}
          </DismissibleAlert>
        );
      })}
    </>
  );
}
