import { Alert, Box, Button, Code, Group, Modal, Stack, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { OFFSITE_MOD_REASON_MIN } from '~/server/schema/blocks/offsite-moderation.schema';

/**
 * Shared reason-gated action UI (App Blocks moderator surfaces). BEFORE this, four
 * separate modals hand-rolled the "reason textarea + ≥{@link OFFSITE_MOD_REASON_MIN}
 * gate + disabled submit" pattern, and only the two REJECT paths got the #3154 UX
 * (a live `N/min` counter, an inline "too short" error, and a disabled-with-Tooltip
 * submit). The post-approval action modals (reset / hide / relist / claim / purge)
 * showed only a static label + a dead greyed button.
 *
 * These primitives give EVERY reason-required action the same feedback:
 *  - {@link ReasonGatedField} — the reason textarea + the live counter + the inline
 *    too-short error (the counter/error are suppressed for an OPTIONAL note).
 *  - {@link ReasonGatedSubmitButton} — the submit button wrapped in a disabled
 *    Tooltip (Mantine's documented Box-wrapper pattern, since a native disabled
 *    `<button>` fires no pointer events) that explains the closed gate on hover.
 *  - {@link ReasonGatedActionModal} — the full single-action modal composing both,
 *    plus optional slots for a claim-target input and the destructive typed-slug
 *    purge confirm. Consumed by the mgmt-table + reports-queue action modals.
 *
 * The two inline reject panels (OnsiteReviewModal / OffsiteReviewModal) live INSIDE
 * a larger review modal, so they consume the two atoms directly rather than the
 * whole modal shell. Mutation wiring/semantics stay with each caller — this is a
 * UX-consistency + dedup layer, not a behaviour change to the actions.
 */

/** The default hover hint for the disabled reason gate (matches the #3154 reject copy). */
export function reasonGateTooltip(minLength: number = OFFSITE_MOD_REASON_MIN): string {
  return `Enter a reason — at least ${minLength} characters.`;
}

/** Whether a reason value clears the minimum-length floor (trimmed). */
export function reasonMeetsMin(value: string, minLength: number = OFFSITE_MOD_REASON_MIN): boolean {
  return value.trim().length >= minLength;
}

export function ReasonGatedField({
  value,
  onChange,
  disabled,
  minLength = OFFSITE_MOD_REASON_MIN,
  required = true,
  label,
  placeholder,
  testId,
  minRows = 3,
  maxRows = 8,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  minLength?: number;
  /** When false, this is an OPTIONAL note — no counter, no floor, no inline error. */
  required?: boolean;
  label?: ReactNode;
  placeholder?: string;
  testId?: string;
  minRows?: number;
  maxRows?: number;
}) {
  const len = value.trim().length;
  const tooShort = required && len < minLength;
  return (
    <Textarea
      label={label}
      autosize
      minRows={minRows}
      maxRows={maxRows}
      placeholder={placeholder}
      // Live counter — only meaningful when a floor applies.
      description={required ? `${len}/${minLength} characters minimum` : undefined}
      // Inline error once the mod has typed SOMETHING but not enough (an empty field
      // shows the neutral counter, not a red error).
      error={tooShort && len > 0 ? `Enter at least ${minLength} characters.` : undefined}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      disabled={disabled}
      data-testid={testId}
    />
  );
}

export function ReasonGatedSubmitButton({
  onClick,
  gateOpen,
  busy,
  label,
  color,
  leftSection,
  tooltipLabel,
  testId,
}: {
  onClick: () => void;
  /** The full gate (reason + any extra inputs). When false the Tooltip shows. */
  gateOpen: boolean;
  busy?: boolean;
  label: ReactNode;
  color?: string;
  leftSection?: ReactNode;
  tooltipLabel?: string;
  testId?: string;
}) {
  return (
    <Tooltip label={tooltipLabel ?? reasonGateTooltip()} disabled={gateOpen} withArrow>
      {/* A native disabled <button> fires no pointer events, so the Tooltip attaches
          to a wrapper to show in the exact disabled state it explains. */}
      <Box>
        <Button
          color={color}
          leftSection={leftSection}
          onClick={onClick}
          disabled={busy || !gateOpen}
          loading={busy}
          data-testid={testId}
        >
          {label}
        </Button>
      </Box>
    </Tooltip>
  );
}

export function ReasonGatedActionModal({
  opened,
  onCancel,
  title,
  busy,
  reason,
  onReasonChange,
  reasonRequired = true,
  minLength = OFFSITE_MOD_REASON_MIN,
  reasonLabel,
  reasonPlaceholder = 'Why this action — recorded in the audit trail.',
  reasonTestId,
  destructive = false,
  destructiveWarning,
  /** When a non-empty string, render the typed-slug purge confirm and gate on an
   *  exact match. Undefined/empty → no typed-slug confirm (e.g. the reports queue). */
  confirmSlug,
  confirmValue = '',
  onConfirmChange,
  confirmTestId,
  /** Extra content (e.g. a claim target-owner input + its notice) rendered above the reason. */
  extraSlot,
  /** An additional gate condition (e.g. a valid claim target). Defaults to satisfied. */
  extraGateSatisfied = true,
  extraGateTooltip,
  submitLabel,
  submitTestId,
  onSubmit,
}: {
  opened: boolean;
  onCancel: () => void;
  title: ReactNode;
  busy?: boolean;
  reason: string;
  onReasonChange: (value: string) => void;
  reasonRequired?: boolean;
  minLength?: number;
  reasonLabel?: ReactNode;
  reasonPlaceholder?: string;
  reasonTestId?: string;
  destructive?: boolean;
  destructiveWarning?: ReactNode;
  confirmSlug?: string | null;
  confirmValue?: string;
  onConfirmChange?: (value: string) => void;
  confirmTestId?: string;
  extraSlot?: ReactNode;
  extraGateSatisfied?: boolean;
  extraGateTooltip?: string;
  submitLabel: ReactNode;
  submitTestId?: string;
  onSubmit: () => void;
}) {
  const reasonMet = !reasonRequired || reasonMeetsMin(reason, minLength);
  const hasTypedConfirm = !!confirmSlug;
  const confirmMatches = !hasTypedConfirm || confirmValue.trim() === confirmSlug;
  const gateOpen = reasonMet && extraGateSatisfied && confirmMatches;

  // Explain the FIRST unmet gate on hover (reason floor is the most common).
  const tooltipLabel = !reasonMet
    ? reasonGateTooltip(minLength)
    : !extraGateSatisfied
    ? extraGateTooltip ?? 'Complete the required fields.'
    : !confirmMatches
    ? `Type the slug to confirm.`
    : undefined;

  return (
    <Modal
      opened={opened}
      onClose={() => {
        if (busy) return;
        onCancel();
      }}
      title={title}
      centered
    >
      <Stack gap="md">
        {destructive && (
          <>
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
              {destructiveWarning ?? (
                <Text size="sm">
                  This PERMANENTLY deletes the listing and its screenshots + reports. The audit
                  event (with the slug snapshot) is kept. This cannot be undone.
                </Text>
              )}
            </Alert>
            {hasTypedConfirm && (
              <TextInput
                label={
                  <Text size="sm">
                    Type the slug <Code>{confirmSlug}</Code> to confirm
                  </Text>
                }
                placeholder={confirmSlug ?? undefined}
                value={confirmValue}
                onChange={(e) => onConfirmChange?.(e.currentTarget.value)}
                disabled={busy}
                error={
                  confirmValue.length > 0 && !confirmMatches ? 'Does not match the slug' : undefined
                }
                data-testid={confirmTestId}
              />
            )}
          </>
        )}
        {extraSlot}
        <ReasonGatedField
          value={reason}
          onChange={onReasonChange}
          disabled={busy}
          required={reasonRequired}
          minLength={minLength}
          label={reasonLabel}
          placeholder={reasonPlaceholder}
          testId={reasonTestId}
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <ReasonGatedSubmitButton
            onClick={onSubmit}
            gateOpen={gateOpen}
            busy={busy}
            color={destructive ? 'red' : undefined}
            label={submitLabel}
            tooltipLabel={tooltipLabel}
            testId={submitTestId}
          />
        </Group>
      </Stack>
    </Modal>
  );
}
