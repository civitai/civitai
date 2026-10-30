import { Alert, Button, Checkbox, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useState } from 'react';

import {
  ReasonGatedField,
  ReasonGatedSubmitButton,
} from '~/components/Apps/ReasonGatedActionModal';
import {
  modMessageGate,
  modMessagePayload,
  modMessageSentSummary,
  modMessageSubjectState,
} from '~/components/Apps/appModeratorMessageForm';
import {
  MOD_MESSAGE_BODY_MAX,
  MOD_MESSAGE_BODY_MIN,
  MOD_MESSAGE_SUBJECT_MAX,
  MOD_MESSAGE_SUBJECT_MIN,
} from '~/server/schema/blocks/app-moderator-message.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * MODERATOR → APP-DEVELOPER message composer.
 *
 * ## Why this component exists
 *
 * `appListings.messageAppOwner` (civitai/civitai#4401) shipped with a service, an audit
 * event, two Redis rate-limit windows, a notification type and a migration — and ZERO
 * UI callers. A moderator who needed to tell a developer something the platform has no
 * event for could not reach it from any surface. This is that surface.
 *
 * ## Why it is NOT `ListingModActionModal`
 *
 * Every other moderator action on this table is gated on ONE free-text `reason` with a
 * single floor (`OFFSITE_MOD_REASON_MIN` = 3), which is exactly what the shared
 * {@link ReasonGatedActionModal} shell encodes. This action takes TWO fields with
 * DIFFERENT floors (subject ≥ 3, body ≥ 20) and two server-enforced CEILINGS, and it
 * carries a delivery-scope choice. Overloading the shell would have meant a `reason`
 * prop that is really a body, an `extraSlot` that is really a required field, and a
 * `minLength` that only describes one of the two gates.
 *
 * It still composes the shell's ATOMS ({@link ReasonGatedField} +
 * {@link ReasonGatedSubmitButton}) rather than hand-rolling a textarea and a disabled
 * button — the same call the two inline reject panels make, and the reason the atoms
 * were split out from the shell in the first place.
 *
 * ## What it deliberately does NOT do
 *
 * No draft persistence, no template picker, no thread. The proc is one-way by design
 * (there is no reply route and no message table), so a composer that implied otherwise
 * would be lying about the channel.
 *
 * It also NAMES NO RECIPIENT — see the `listing` prop below. The only owner a caller
 * could hand it is the denormalised column, which the send may resolve past.
 */
export function MessageAppOwnerModal({
  listing,
  onClose,
  onSent,
}: {
  /**
   * The listing to message the owner of, or `null` when closed. `appListingId` is the
   * `apl_<ULID>` (`ModerationListingRow.id`); the proc also accepts a shadow revision
   * id and resolves it to the parent, so no caller has to know which it holds.
   *
   * 🔴 THE RECIPIENT IS NOT PASSED, AND THIS TYPE DELIBERATELY CANNOT CARRY ONE.
   * `messageAppOwner` derives the owner server-side through `resolveListingAccess`,
   * which for an ON-SITE listing resolves the backing block's owner and NOT the
   * listing's own `userId` column — `resolveCanonicalListingOwner` exists precisely to
   * override that denormalised copy. The mod table holds only the copy, so any owner
   * this composer could be handed is a value the send may disagree with, and a
   * composer that displayed it would let a moderator write to the person on screen
   * while the platform delivered to a different one. That is a disclosure, not merely
   * a mislabel. So the composer names no recipient at all: the table's own Owner
   * column stays the (clearly denormalised) display, and the send resolves the real
   * one. An earlier revision of this file said exactly that in prose and then
   * rendered the label anyway — hence the prop-shape ledger in
   * `__tests__/appModeratorMessageForm.callSites.test.ts`.
   */
  listing: { appListingId: string; slug: string } | null;
  onClose: () => void;
  /** Fired after a successful send (the table's invalidate). */
  onSent?: () => void | Promise<void>;
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [includeCollaborators, setIncludeCollaborators] = useState(false);

  function reset() {
    setSubject('');
    setBody('');
    setIncludeCollaborators(false);
  }

  const mutation = trpc.appListings.messageAppOwner.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({ message: modMessageSentSummary(result.recipientCount) });
      await onSent?.();
      reset();
      onClose();
    },
    // 🔴 The composed text is NOT cleared on failure. Every typed failure this proc can
    // return is RETRYABLE by the moderator — RATE_LIMITED says "try again in Ns",
    // BLOCKED_LINK and INVALID_TEXT say "edit this text" — so discarding the body would
    // destroy work the error is asking them to reuse. The modal stays open for the
    // same reason.
    onError: (e) => showErrorNotification({ title: 'Message failed', error: new Error(e.message) }),
  });

  if (!listing) return null;

  const subjectState = modMessageSubjectState(subject);
  const gate = modMessageGate({ subject, body });
  const busy = mutation.isPending;

  function submit() {
    if (!listing || !gate.open) return;
    mutation.mutate(
      modMessagePayload({
        appListingId: listing.appListingId,
        subject,
        body,
        includeCollaborators,
      })
    );
  }

  function cancel() {
    if (busy) return;
    reset();
    onClose();
  }

  return (
    <Modal
      opened
      onClose={cancel}
      centered
      title={<Text fw={600}>Message owner — {listing.slug}</Text>}
    >
      <Stack gap="md">
        <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
          {/* 🔴 NAMES NO RECIPIENT. The owner is resolved when the message is sent, and
              for an on-site listing that resolution can disagree with the owner this
              table displays — see the `listing` prop's docstring. */}
          <Text size="sm">
            Delivered as a notification to the app&apos;s owner, resolved when you send. One-way —
            replies are not delivered — and the subject and message are recorded in this
            listing&apos;s moderation history.
          </Text>
        </Alert>

        <TextInput
          label="Subject"
          placeholder="e.g. Your listing describes a feature the app does not have"
          description={
            `${subjectState.length}/${MOD_MESSAGE_SUBJECT_MIN} characters minimum ` +
            `(max ${MOD_MESSAGE_SUBJECT_MAX})`
          }
          error={
            subjectState.tooLong
              ? `Keep it to ${MOD_MESSAGE_SUBJECT_MAX} characters or fewer (currently ${subjectState.length}).`
              : subjectState.tooShort && subjectState.length > 0
              ? `Enter at least ${MOD_MESSAGE_SUBJECT_MIN} characters.`
              : undefined
          }
          value={subject}
          onChange={(e) => setSubject(e.currentTarget.value)}
          disabled={busy}
          data-testid="apps-mod-message-subject"
        />

        <ReasonGatedField
          value={body}
          onChange={setBody}
          disabled={busy}
          minLength={MOD_MESSAGE_BODY_MIN}
          maxLength={MOD_MESSAGE_BODY_MAX}
          label="Message"
          placeholder="What the developer needs to know, and what (if anything) they should change."
          testId="apps-mod-message-body"
          minRows={5}
        />

        {/* 🔴 DEFAULTS OFF, mirroring the schema. An accepted collaborator consented to
            EDIT the app, not to receive moderation correspondence about it — and a
            moderator's message can be adverse. Opt in per message, never per session. */}
        <Checkbox
          label="Also send to accepted collaborators"
          description="Off by default — the owner is the accountable party. Turn this on when the owner is unresponsive and the editors are the only people who can fix the listing."
          checked={includeCollaborators}
          onChange={(e) => setIncludeCollaborators(e.currentTarget.checked)}
          disabled={busy}
          data-testid="apps-mod-message-collaborators"
        />

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <ReasonGatedSubmitButton
            onClick={submit}
            gateOpen={gate.open}
            busy={busy}
            label="Send message"
            tooltipLabel={gate.tooltip}
            testId="apps-mod-message-send"
          />
        </Group>
      </Stack>
    </Modal>
  );
}
