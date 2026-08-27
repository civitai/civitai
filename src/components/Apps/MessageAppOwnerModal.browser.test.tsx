import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import {
  MOD_MESSAGE_BODY_MAX,
  MOD_MESSAGE_BODY_MIN,
  MOD_MESSAGE_SUBJECT_MAX,
  MOD_MESSAGE_SUBJECT_MIN,
} from '~/server/schema/blocks/app-moderator-message.schema';

/**
 * The moderator → app-developer message composer (`appListings.messageAppOwner`, which
 * shipped with no UI at all). Browser-mode (report-only in Tekton): the two-field gate,
 * the collaborator opt-in, the exact mutation payload, and the failure posture.
 *
 * The gate RULE is pinned in the blocking node project by
 * `__tests__/appModeratorMessageForm.test.ts`; this file pins that the COMPONENT is
 * wired to it.
 */

const A = (n: number) => 'a'.repeat(n);
const OK_SUBJECT = A(MOD_MESSAGE_SUBJECT_MIN + 5);
const OK_BODY = A(MOD_MESSAGE_BODY_MIN + 5);

// 🔴 NO OWNER FIELD, and the prop type refuses one: the recipient is resolved
// server-side at send time and the mod table only holds a denormalised copy of it.
const LISTING = { appListingId: 'apl_1', slug: 'prompt-vault' };

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  onClose: vi.fn(),
  onSent: vi.fn().mockResolvedValue(undefined),
  errorMode: false,
  /** What the mocked proc resolves with — drives the success-toast copy. */
  recipientCount: 1,
}));

const showSuccess = vi.fn();
const showError = vi.fn();
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: (...a: unknown[]) => showSuccess(...a),
  showErrorNotification: (...a: unknown[]) => showError(...a),
}));

// 🔴 `importOriginal` SPREAD, not a wholesale replacement (local-rules/
// no-wholesale-module-mock): a hand-written factory breaks this whole FILE's ESM link
// the day `~/utils/trpc` gains an export the factory omits, and that failure reports as
// "0 tests collected" rather than as a failure.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: {
      appListings: {
        messageAppOwner: {
          useMutation: (opts?: {
            onSuccess?: (r: { recipientCount: number }) => void | Promise<void>;
            onError?: (e: { message: string }) => void;
          }) => ({
            mutate: (vars: unknown) => {
              mocks.mutate(vars);
              if (mocks.errorMode) opts?.onError?.({ message: 'Too many moderator messages' });
              else void opts?.onSuccess?.({ recipientCount: mocks.recipientCount });
            },
            mutateAsync: vi.fn(),
            isPending: false,
          }),
        },
      },
    },
  };
});

const { MessageAppOwnerModal } = await import('./MessageAppOwnerModal');

function render(listing: typeof LISTING | null = LISTING) {
  return renderWithProviders(
    <MessageAppOwnerModal listing={listing} onClose={mocks.onClose} onSent={mocks.onSent} />
  );
}

beforeEach(() => {
  mocks.mutate.mockClear();
  mocks.onClose.mockClear();
  mocks.onSent.mockClear();
  mocks.errorMode = false;
  mocks.recipientCount = 1;
  showSuccess.mockClear();
  showError.mockClear();
});

describe('MessageAppOwnerModal — closed state', () => {
  test('renders nothing when no listing is selected', async () => {
    render(null);
    expect(page.getByTestId('apps-mod-message-subject').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-mod-message-send').elements()).toHaveLength(0);
  });
});

describe('MessageAppOwnerModal — the two-field gate', () => {
  test('the send button is disabled on an empty form, and no mutation fires', async () => {
    render();
    await expect.element(page.getByTestId('apps-mod-message-send')).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('a valid SUBJECT alone is not enough — the body floor still closes the gate', async () => {
    render();
    await page.getByTestId('apps-mod-message-subject').fill(OK_SUBJECT);
    await expect.element(page.getByTestId('apps-mod-message-send')).toBeDisabled();

    // 🔴 The discriminating case: text that clears the SUBJECT floor and not the BODY
    // floor. A composer that reused one floor for both fields enables here.
    await page.getByTestId('apps-mod-message-body').fill(A(MOD_MESSAGE_SUBJECT_MIN));
    await expect.element(page.getByTestId('apps-mod-message-send')).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('a valid BODY alone is not enough — the subject is required', async () => {
    render();
    await page.getByTestId('apps-mod-message-body').fill(OK_BODY);
    await expect.element(page.getByTestId('apps-mod-message-send')).toBeDisabled();
  });

  test('both fields valid → the button enables', async () => {
    render();
    await page.getByTestId('apps-mod-message-subject').fill(OK_SUBJECT);
    await page.getByTestId('apps-mod-message-body').fill(OK_BODY);
    await expect.element(page.getByTestId('apps-mod-message-send')).toBeEnabled();
  });

  test('the body counter shows the floor AND the ceiling, and climbs as text is typed', async () => {
    render();
    await expect
      .element(
        page.getByText(`0/${MOD_MESSAGE_BODY_MIN} characters minimum (max ${MOD_MESSAGE_BODY_MAX})`)
      )
      .toBeInTheDocument();
    await page.getByTestId('apps-mod-message-body').fill('ab');
    await expect
      .element(
        page.getByText(`2/${MOD_MESSAGE_BODY_MIN} characters minimum (max ${MOD_MESSAGE_BODY_MAX})`)
      )
      .toBeInTheDocument();
  });

  /**
   * 🔴 THE CEILING GATE. Every field clears its FLOOR here, so a floor-only composer
   * enables the button, fires, and the moderator gets an unattributed BAD_REQUEST with
   * their text still in the box.
   */
  test('an over-length BODY disables the send and names the ceiling', async () => {
    render();
    await page.getByTestId('apps-mod-message-subject').fill(OK_SUBJECT);
    await page.getByTestId('apps-mod-message-body').fill(A(MOD_MESSAGE_BODY_MAX + 1));
    await expect.element(page.getByTestId('apps-mod-message-send')).toBeDisabled();
    await expect
      .element(
        page.getByText(`Keep it to ${MOD_MESSAGE_BODY_MAX} characters or fewer`, { exact: false })
      )
      .toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  test('an over-length SUBJECT disables the send and names the ceiling', async () => {
    render();
    await page.getByTestId('apps-mod-message-subject').fill(A(MOD_MESSAGE_SUBJECT_MAX + 1));
    await page.getByTestId('apps-mod-message-body').fill(OK_BODY);
    await expect.element(page.getByTestId('apps-mod-message-send')).toBeDisabled();
    await expect
      .element(
        page.getByText(`Keep it to ${MOD_MESSAGE_SUBJECT_MAX} characters or fewer`, {
          exact: false,
        })
      )
      .toBeInTheDocument();
  });

  test('a whitespace-only body cannot open the gate', async () => {
    render();
    await page.getByTestId('apps-mod-message-subject').fill(OK_SUBJECT);
    await page.getByTestId('apps-mod-message-body').fill(' '.repeat(MOD_MESSAGE_BODY_MIN + 10));
    await expect.element(page.getByTestId('apps-mod-message-send')).toBeDisabled();
  });
});

describe('MessageAppOwnerModal — the mutation payload', () => {
  test('sends the trimmed subject + body against the LISTING ID, collaborators omitted by default', async () => {
    render();
    await page.getByTestId('apps-mod-message-subject').fill(`  ${OK_SUBJECT}  `);
    await page.getByTestId('apps-mod-message-body').fill(`  ${OK_BODY}  `);
    await page.getByTestId('apps-mod-message-send').click();
    expect(mocks.mutate).toHaveBeenCalledWith({
      appListingId: 'apl_1',
      subject: OK_SUBJECT,
      body: OK_BODY,
    });
  });

  test('the collaborator checkbox is OFF by default and adds includeCollaborators when ticked', async () => {
    render();
    await expect.element(page.getByTestId('apps-mod-message-collaborators')).not.toBeChecked();
    await page.getByTestId('apps-mod-message-subject').fill(OK_SUBJECT);
    await page.getByTestId('apps-mod-message-body').fill(OK_BODY);
    await page.getByTestId('apps-mod-message-collaborators').click();
    await page.getByTestId('apps-mod-message-send').click();
    expect(mocks.mutate).toHaveBeenCalledWith({
      appListingId: 'apl_1',
      subject: OK_SUBJECT,
      body: OK_BODY,
      includeCollaborators: true,
    });
  });
});

describe('MessageAppOwnerModal — success and failure posture', () => {
  test('a successful send toasts, calls onSent, and closes', async () => {
    render();
    await page.getByTestId('apps-mod-message-subject').fill(OK_SUBJECT);
    await page.getByTestId('apps-mod-message-body').fill(OK_BODY);
    await page.getByTestId('apps-mod-message-send').click();
    await vi.waitFor(() => expect(mocks.onClose).toHaveBeenCalled());
    expect(showSuccess).toHaveBeenCalledWith({ message: 'Message sent to the app owner.' });
    expect(mocks.onSent).toHaveBeenCalled();
  });

  /**
   * 🔴 OPT IN PER MESSAGE, NEVER PER SESSION. An accepted collaborator consented to EDIT
   * the app, not to receive moderation correspondence about it — and a moderator's
   * message can be adverse. The composer is not unmounted between sends (the parent owns
   * `listing`), so a tick that survived a send would silently fan the NEXT message out to
   * third parties the moderator never opted in for.
   *
   * Until this test existed, deleting `setIncludeCollaborators(false)` from `reset()`
   * survived both suites — the property was a comment, not behaviour. The second send
   * below is the half that catches it: the checkbox assertion alone would still pass a
   * composer that re-rendered unchecked while holding stale state.
   */
  test('a successful send clears the collaborator opt-in, and the NEXT message does not carry it', async () => {
    render();
    await page.getByTestId('apps-mod-message-subject').fill(OK_SUBJECT);
    await page.getByTestId('apps-mod-message-body').fill(OK_BODY);
    await page.getByTestId('apps-mod-message-collaborators').click();
    await expect.element(page.getByTestId('apps-mod-message-collaborators')).toBeChecked();

    await page.getByTestId('apps-mod-message-send').click();
    await vi.waitFor(() => expect(mocks.onClose).toHaveBeenCalled());
    expect(mocks.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeCollaborators: true })
    );

    // Every field is back to its initial state — the opt-in included.
    await expect.element(page.getByTestId('apps-mod-message-collaborators')).not.toBeChecked();
    await expect.element(page.getByTestId('apps-mod-message-subject')).toHaveValue('');
    await expect.element(page.getByTestId('apps-mod-message-body')).toHaveValue('');

    // …and the state behind it, not merely the rendered tick: a second message composed
    // in the same still-mounted modal must omit `includeCollaborators` entirely.
    mocks.mutate.mockClear();
    await page.getByTestId('apps-mod-message-subject').fill(OK_SUBJECT);
    await page.getByTestId('apps-mod-message-body').fill(OK_BODY);
    await page.getByTestId('apps-mod-message-send').click();
    expect(mocks.mutate).toHaveBeenCalledWith({
      appListingId: 'apl_1',
      subject: OK_SUBJECT,
      body: OK_BODY,
    });
  });

  test('the success toast names the RECIPIENT COUNT once collaborators were included', async () => {
    mocks.recipientCount = 3;
    render();
    await page.getByTestId('apps-mod-message-subject').fill(OK_SUBJECT);
    await page.getByTestId('apps-mod-message-body').fill(OK_BODY);
    await page.getByTestId('apps-mod-message-send').click();
    await vi.waitFor(() => expect(showSuccess).toHaveBeenCalled());
    expect(showSuccess).toHaveBeenCalledWith({ message: 'Message sent to 3 recipients.' });
  });

  /**
   * 🔴 A FAILED SEND MUST NOT DESTROY THE MESSAGE. Every typed failure this proc
   * returns is retryable by the moderator — RATE_LIMITED says "try again in Ns",
   * BLOCKED_LINK and INVALID_TEXT say "edit this text" — so clearing the body would
   * throw away the work the error is asking them to reuse.
   */
  test('a failed send toasts the error, keeps the modal open, and keeps the typed text', async () => {
    mocks.errorMode = true;
    render();
    await page.getByTestId('apps-mod-message-subject').fill(OK_SUBJECT);
    await page.getByTestId('apps-mod-message-body').fill(OK_BODY);
    await page.getByTestId('apps-mod-message-send').click();

    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ title: 'Message failed' }));
    expect(mocks.onClose).not.toHaveBeenCalled();
    expect(mocks.onSent).not.toHaveBeenCalled();
    await expect.element(page.getByTestId('apps-mod-message-body')).toHaveValue(OK_BODY);
    await expect.element(page.getByTestId('apps-mod-message-subject')).toHaveValue(OK_SUBJECT);
  });
});

describe('MessageAppOwnerModal — the delivery notice', () => {
  test('says the message is one-way, audited, and resolved at send time', async () => {
    render();
    await expect
      .element(page.getByText('replies are not delivered', { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('moderation history', { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('resolved when you send', { exact: false }))
      .toBeInTheDocument();
  });

  /**
   * 🔴 It must not name a specific person. For an on-site listing the send resolves the
   * BACKING BLOCK's owner, which can differ from the listing column the mod table
   * displays — so a composer that echoed a handle would let a moderator address copy to
   * one developer while the platform delivered it to another.
   */
  test('names no recipient — the notice is exactly the sentence that names none', async () => {
    render();
    // Await the notice first: the modal is portalled and `render()` returns before it is
    // in the DOM, so a synchronous read of `document.body` sees an empty string — which
    // would make the assertions below pass over nothing at all.
    await expect
      .element(page.getByText('resolved when you send', { exact: false }))
      .toBeInTheDocument();
    // Scoped to the dialog, not `document.body`: the body also carries Mantine's
    // injected <style> block, whose `@media` rules match the handle pattern below and
    // would fail this for a reason that has nothing to do with the copy.
    const composer = page.getByRole('dialog').element().textContent ?? '';
    // 🔴 THE WHOLE SENTENCE, not a pattern. The `/[@#]\w/` check this replaced was a
    // SPELLED guard: rewriting the notice as "…to the app owner devuser, resolved when
    // you send" names a recipient in plain prose, matches no handle sigil, and passed
    // all 17 tests in this file. A reword now fails here on purpose — the copy is a
    // claim about where a moderation message goes.
    expect(composer).toContain(
      "Delivered as a notification to the app's owner, resolved when you send. " +
        'One-way — replies are not delivered — and the subject and message are recorded ' +
        "in this listing's moderation history."
    );
    // Kept beside it: the sigil pattern still catches a handle appended ANYWHERE else in
    // the composer, which a single-string assertion on one paragraph cannot see.
    expect(composer).not.toMatch(/[@#]\w/);
  });
});
