import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { CollaboratorRosterRow } from '~/components/Apps/AppCollaboratorsPanelView';
import {
  AppCollaboratorsPanelView,
  inviteBlockedReason,
  pickerExcludedUserIds,
} from '~/components/Apps/AppCollaboratorsPanelView';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';
import { CONNECT_CLIENT_TRANSFER_REFUSAL } from '~/shared/constants/app-transfer.constants';

/**
 * The collaborator roster panel, driven props-only (the container's tRPC + search-stack
 * wiring is deliberately out of frame — every rule that decides which control renders
 * lives in the View).
 */

const ONSITE = capabilitiesForKind('onsite');
const OFFSITE = capabilitiesForKind('offsite');

const OWNER_ID = 10;
const EDITOR_ID = 20;

function seat(over: Partial<CollaboratorRosterRow> & { userId: number }): CollaboratorRosterRow {
  return { role: 'editor', status: 'accepted', displayed: true, invitedBy: OWNER_ID, ...over };
}

describe('AppCollaboratorsPanelView — the invite EARNINGS DISCLOSURE', () => {
  /**
   * 🔴 ASSERTED ON THE RENDERED OUTPUT, not on the source of `inviteDisclosureItems`.
   * A unit test of that function would pass on a panel that never mounts it — which is
   * exactly the shape of failure this whole PR exists to fix.
   */
  test('an ON-SITE owner is told, BEFORE inviting, that a collaborator sees earnings', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[]}
        viewerUserId={OWNER_ID}
        userPicker={<div data-testid="stub-picker" />}
      />
    );
    const disclosure = page.getByTestId('apps-collaborators-invite-disclosure');
    await expect.element(disclosure).toBeInTheDocument();
    await expect.element(disclosure).toHaveTextContent(/Buzz earnings/i);
    await expect.element(disclosure).toHaveTextContent(/payout/i);
    // …and it is present in the same render as the picker, i.e. before sending.
    await expect.element(page.getByTestId('stub-picker')).toBeInTheDocument();
  });

  test('the disclosure also names the code/version access an on-site seat grants', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[]}
        viewerUserId={OWNER_ID}
      />
    );
    await expect
      .element(page.getByTestId('apps-collaborators-invite-disclosure'))
      .toHaveTextContent(/Push code/i);
  });

  /**
   * 🔴 THE OTHER DIRECTION, and it is not symmetry-for-its-own-sake: an off-site listing
   * has no AppBlock, so no `BlockBuzzAttribution` row can exist and there is no repo.
   * Promising an off-site invitee earnings or git access would be a lie, and
   * `getAppEarnings` refuses that listing with `unsupportedKind`.
   */
  test('an OFF-SITE owner is NOT promised earnings or code access', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={OFFSITE}
        rows={[]}
        viewerUserId={OWNER_ID}
      />
    );
    const disclosure = page.getByTestId('apps-collaborators-invite-disclosure');
    await expect.element(disclosure).toBeInTheDocument();
    await expect.element(disclosure).not.toHaveTextContent(/Buzz earnings/i);
    await expect.element(disclosure).not.toHaveTextContent(/Push code/i);
    // The capabilities BOTH kinds share are still disclosed.
    await expect.element(disclosure).toHaveTextContent(/store listing/i);
    await expect.element(disclosure).toHaveTextContent(/analytics/i);
  });
});

describe('AppCollaboratorsPanelView — who may do what', () => {
  test('an OWNER gets the invite picker and a Remove control per row', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[seat({ userId: EDITOR_ID })]}
        viewerUserId={OWNER_ID}
        userPicker={<div data-testid="stub-picker" />}
        onRemove={() => undefined}
      />
    );
    await expect.element(page.getByTestId('stub-picker')).toBeInTheDocument();
    await expect
      .element(page.getByTestId(`apps-collaborator-remove-${EDITOR_ID}`))
      .toBeInTheDocument();
  });

  /**
   * 🔴 `remove` and `invite` are owner-only in the SERVICE (`assertOwner`), so rendering
   * them for an editor would be rendering a guaranteed FORBIDDEN.
   */
  test('an EDITOR gets NO picker and NO Remove control, and is told why', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="editor"
        capabilities={ONSITE}
        rows={[seat({ userId: EDITOR_ID })]}
        viewerUserId={EDITOR_ID}
        userPicker={<div data-testid="stub-picker" />}
        onRemove={() => undefined}
      />
    );
    // 🔴 AWAIT A PRESENT ELEMENT FIRST. `locator.elements()` is SYNCHRONOUS, so an
    // absence asserted before React has committed passes whatever the component renders —
    // a mutation survived exactly that shape elsewhere in this suite. The editor notice
    // (which this branch MUST render) is the proof that the tree is committed.
    await expect.element(page.getByTestId('apps-collaborators-editor-notice')).toBeInTheDocument();
    expect(page.getByTestId('stub-picker').elements()).toHaveLength(0);
    expect(page.getByTestId(`apps-collaborator-remove-${EDITOR_ID}`).elements()).toHaveLength(0);
    expect(page.getByTestId('apps-collaborators-invite-disclosure').elements()).toHaveLength(0);
  });

  test('Remove passes the row’s user id, not the viewer’s', async () => {
    const removed: number[] = [];
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[seat({ userId: 77 }), seat({ userId: 88 })]}
        viewerUserId={OWNER_ID}
        onRemove={(id) => removed.push(id)}
      />
    );
    const removeBtn = page.getByTestId('apps-collaborator-remove-88');
    await expect.element(removeBtn).toBeInTheDocument();
    await userEvent.click(removeBtn.element());
    expect(removed).toEqual([88]);
  });
});

describe('AppCollaboratorsPanelView — the `displayed` byline flag', () => {
  /**
   * 🔴 TWO CONTROLS, TWO OWNERS OF THE DECISION, and this is a deliberate product
   * decision rather than an emergent capability:
   *   - every accepted collaborator controls their OWN byline (the "Your seat" switch);
   *   - the app OWNER additionally controls EVERY seat's byline (the per-row switch).
   *
   * The narrower model — self-service only, owner read-only — was implemented first and
   * explicitly overruled. It is written down here because a later reader looking at an
   * owner who can strip a collaborator's public credit should be able to tell "decided"
   * from "not yet noticed".
   */
  test('the toggle renders on the VIEWER’s own accepted seat', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="editor"
        capabilities={ONSITE}
        rows={[seat({ userId: EDITOR_ID, displayed: true })]}
        viewerUserId={EDITOR_ID}
        onSetDisplayed={() => undefined}
      />
    );
    await expect
      .element(page.getByTestId('apps-collaborator-displayed-toggle'))
      .toBeInTheDocument();
  });

  test('an OWNER gets a PER-SEAT toggle on another collaborator’s row', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[seat({ userId: EDITOR_ID, displayed: false })]}
        viewerUserId={OWNER_ID}
        onSetDisplayed={() => undefined}
      />
    );
    const toggle = page.getByTestId(`apps-collaborator-row-displayed-${EDITOR_ID}`);
    await expect.element(toggle).toBeInTheDocument();
    // It reflects the row's CURRENT state, not a default.
    expect((toggle.element() as HTMLInputElement).checked).toBe(false);
  });

  test('the per-seat toggle reports the ROW’s user id, not the viewer’s', async () => {
    const calls: Array<[boolean, number | undefined]> = [];
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[seat({ userId: 77 }), seat({ userId: 88 })]}
        viewerUserId={OWNER_ID}
        onSetDisplayed={(displayed, targetUserId) => calls.push([displayed, targetUserId])}
      />
    );
    const toggle = page.getByTestId('apps-collaborator-row-displayed-88');
    await expect.element(toggle).toBeInTheDocument();
    await userEvent.click(toggle.element());
    // 🔴 Both operands matter: the mutant that passes the viewer's id would strip the
    // OWNER's byline instead of the collaborator's, and would look like it worked.
    expect(calls).toEqual([[false, 88]]);
  });

  /**
   * 🔴 THE CASE MOST LIKELY TO BE WRONG. An accepted EDITOR holds a seat, so a gate that
   * asks "does the viewer have a role here?" rather than "is the viewer the OWNER?"
   * would render this control for them — and the service would then refuse it, which is
   * the "never render an action that will 403" rule broken in the other direction.
   */
  test('a non-owner EDITOR gets NO per-seat toggle on a PEER’s row', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="editor"
        capabilities={ONSITE}
        rows={[seat({ userId: EDITOR_ID }), seat({ userId: 99, displayed: false })]}
        viewerUserId={EDITOR_ID}
        onSetDisplayed={() => undefined}
      />
    );
    // The viewer's OWN self-service switch is the commit proof, and must still be there.
    await expect
      .element(page.getByTestId('apps-collaborator-displayed-toggle'))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-collaborator-row-displayed-99').elements()).toHaveLength(0);
    // …and a peer's state is still legible, read-only.
    await expect
      .element(page.getByTestId('apps-collaborator-row-99'))
      .toHaveTextContent(/Hidden from the public byline/i);
  });

  test('an OWNER gets NO per-seat toggle on a PENDING row — an unaccepted seat has no byline', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[seat({ userId: EDITOR_ID, status: 'pending' }), seat({ userId: 55 })]}
        viewerUserId={OWNER_ID}
        onSetDisplayed={() => undefined}
      />
    );
    // POSITIVE CONTROL beside the zero: the ACCEPTED row on the same render DOES get one.
    await expect
      .element(page.getByTestId('apps-collaborator-row-displayed-55'))
      .toBeInTheDocument();
    expect(
      page.getByTestId(`apps-collaborator-row-displayed-${EDITOR_ID}`).elements()
    ).toHaveLength(0);
  });

  test('a PENDING own row gets NO toggle and NO leave — a pending seat is inert', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="editor"
        capabilities={ONSITE}
        rows={[seat({ userId: EDITOR_ID, status: 'pending' })]}
        viewerUserId={EDITOR_ID}
        onSetDisplayed={() => undefined}
        onLeave={() => undefined}
      />
    );
    // The pending ROW must render (it is on the roster) — that is this test's commit
    // proof, so the two absences after it are observations rather than a race.
    await expect
      .element(page.getByTestId(`apps-collaborator-row-${EDITOR_ID}`))
      .toHaveTextContent(/Invite pending/i);
    expect(page.getByTestId('apps-collaborator-displayed-toggle').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-collaborator-leave').elements()).toHaveLength(0);
  });

  test('toggling reports the NEW checked value', async () => {
    const calls: Array<[boolean, number | undefined]> = [];
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="editor"
        capabilities={ONSITE}
        rows={[seat({ userId: EDITOR_ID, displayed: true })]}
        viewerUserId={EDITOR_ID}
        onSetDisplayed={(v, t) => calls.push([v, t])}
      />
    );
    const toggle = page.getByTestId('apps-collaborator-displayed-toggle');
    await expect.element(toggle).toBeInTheDocument();
    await userEvent.click(toggle.element());
    // 🔴 NO target id on the self path — that absence is what selects the service's
    // self-service branch, so a mutant that always sends the viewer's id would route a
    // plain collaborator through the OWNER gate and 403 them off their own byline.
    expect(calls).toEqual([[false, undefined]]);
  });
});

describe('AppCollaboratorsPanelView — roster states', () => {
  test('an unreadable roster shows the ERROR, never an empty list', async () => {
    // `list` throws NOT_OWNER for a caller with no role. "Unknown" must not render as
    // "nobody" — that would tell an owner their collaborators had vanished.
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[]}
        errorMessage="You do not have access to this app’s collaborators"
        viewerUserId={OWNER_ID}
      />
    );
    await expect.element(page.getByTestId('apps-collaborators-error')).toBeInTheDocument();
    expect(page.getByTestId('apps-collaborators-empty').elements()).toHaveLength(0);
    // POSITIVE CONTROL, reported beside the zero: the same locator DOES find the empty
    // state when the roster really is empty (see the roster-states test below).
  });

  test('pending and rejected rows are labelled as conferring nothing', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[seat({ userId: 1, status: 'pending' }), seat({ userId: 2, status: 'rejected' })]}
        viewerUserId={OWNER_ID}
      />
    );
    await expect
      .element(page.getByTestId('apps-collaborator-row-1'))
      .toHaveTextContent(/Invite pending/i);
    await expect
      .element(page.getByTestId('apps-collaborator-row-2'))
      .toHaveTextContent(/Declined/i);
  });

  test('an empty roster says so', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[]}
        viewerUserId={OWNER_ID}
      />
    );
    await expect.element(page.getByTestId('apps-collaborators-empty')).toBeInTheDocument();
  });
});

/**
 * 🔴 RE-INVITING A DECLINED USER. `inviteCollaborator` implements re-opening a `rejected`
 * seat — "declining is not permanent, and the invitee must consent again" — but the picker
 * excluded EVERY roster row and the guard returned silently, so that service path was
 * unreachable from the UI and the click looked like a broken picker.
 */
describe('inviteBlockedReason / pickerExcludedUserIds', () => {
  const rows = [
    seat({ userId: 1, status: 'accepted' }),
    seat({ userId: 2, status: 'pending' }),
    seat({ userId: 3, status: 'rejected' }),
  ];

  test('a REJECTED seat is re-invitable and stays offerable in the picker', () => {
    expect(inviteBlockedReason(rows, 3)).toBeNull();
    expect(pickerExcludedUserIds(rows)).not.toContain(3);
  });

  test('a user with NO seat is invitable', () => {
    expect(inviteBlockedReason(rows, 99)).toBeNull();
    expect(pickerExcludedUserIds(rows)).not.toContain(99);
  });

  test('an ACCEPTED and a PENDING seat are both blocked, with DISTINCT reasons', () => {
    const accepted = inviteBlockedReason(rows, 1);
    const pending = inviteBlockedReason(rows, 2);
    expect(accepted).not.toBeNull();
    expect(pending).not.toBeNull();
    // 🔴 Distinct copy: "already a collaborator" and "already invited" are different
    // situations, and a shared message would tell an owner the wrong one.
    expect(accepted!.message).not.toBe(pending!.message);
    expect(accepted!.message).toMatch(/already a collaborator/i);
    expect(pending!.message).toMatch(/pending invitation/i);
  });

  test('the picker hides exactly the live seats — accepted and pending, not rejected', () => {
    expect(pickerExcludedUserIds(rows).sort()).toEqual([1, 2]);
  });

  test('🔴 the guard and the picker AGREE on every row (one rule, two readers)', () => {
    // The defect shape this prevents: a user the picker offers but the guard then refuses
    // (a dead click), or one the picker hides but the guard would allow (unreachable).
    for (const row of rows) {
      const blocked = inviteBlockedReason(rows, row.userId) !== null;
      const hidden = pickerExcludedUserIds(rows).includes(row.userId);
      expect(blocked, `disagreement on user ${row.userId}`).toBe(hidden);
    }
  });
});

/**
 * 🔴 OWNERSHIP TRANSFER — THE OWNER HALF of the Collaborators tab.
 *
 * The product rule this pins: a COLLABORATOR cannot transfer the app. The panel says so
 * in its own disclosure ("Collaborators cannot invite or remove anyone, and cannot
 * transfer the app"), the service refuses an editor at `loadOwnedListing` with NOT_OWNER,
 * and this is where the promise and the control are checked against each other.
 */
describe('AppCollaboratorsPanelView — ownership transfer (owner half)', () => {
  test('an OWNER gets the transfer section, its warning, and the recipient picker', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[]}
        viewerUserId={OWNER_ID}
        transferPicker={<div data-testid="stub-transfer-picker" />}
      />
    );
    await expect.element(page.getByTestId('apps-transfer-owner-section')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-transfer-owner-disclosure'))
      .toHaveTextContent(/no longer the owner/i);
    await expect.element(page.getByTestId('stub-transfer-picker')).toBeInTheDocument();
  });

  /**
   * 🔴 ABSENCE, WITH AN AWAITED POSITIVE CONTROL FIRST. `locator.elements()` is
   * SYNCHRONOUS: an emptiness asserted before React commits passes whatever the component
   * renders. The editor notice is the branch this render MUST produce, so awaiting it
   * proves the tree is committed before anything is claimed to be missing.
   */
  test('🔴 an EDITOR gets NO transfer section, NO picker and NO cancel control', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="editor"
        capabilities={ONSITE}
        rows={[seat({ userId: EDITOR_ID })]}
        viewerUserId={EDITOR_ID}
        transferPicker={<div data-testid="stub-transfer-picker" />}
        pendingTransfer={{ id: 'aot_1', toUserId: 99, expiresAt: new Date() }}
        onCancelTransfer={() => undefined}
      />
    );
    await expect.element(page.getByTestId('apps-collaborators-editor-notice')).toBeInTheDocument();
    expect(page.getByTestId('apps-transfer-owner-section').elements()).toHaveLength(0);
    expect(page.getByTestId('stub-transfer-picker').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-transfer-pending').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-transfer-cancel').elements()).toHaveLength(0);
  });

  /**
   * 🔴 POSITIVE CONTROL FOR THE ZEROES ABOVE. Identical props, `role="owner"` — every one
   * of those testids appears. Without this, the four zeroes are indistinguishable from
   * testids that never render for anyone.
   */
  test('🔴 POSITIVE CONTROL: the same props with role="owner" DO render all four', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[seat({ userId: EDITOR_ID })]}
        viewerUserId={OWNER_ID}
        transferPicker={<div data-testid="stub-transfer-picker" />}
        pendingTransfer={{ id: 'aot_1', toUserId: 99, expiresAt: new Date() }}
        onCancelTransfer={() => undefined}
      />
    );
    await expect.element(page.getByTestId('apps-transfer-owner-section')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-transfer-pending')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-transfer-cancel')).toBeInTheDocument();
  });

  /**
   * 🔴 ONE LIVE OFFER PER LISTING is a partial-unique index in the database, so a second
   * initiate loses on P2002. Rendering the picker beside a pending offer would be
   * rendering an action that cannot succeed.
   */
  test('a PENDING offer replaces the picker with the offer and a Cancel control', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[]}
        viewerUserId={OWNER_ID}
        transferPicker={<div data-testid="stub-transfer-picker" />}
        pendingTransfer={{ id: 'aot_1', toUserId: 42, expiresAt: new Date() }}
        onCancelTransfer={() => undefined}
        renderUser={(id) => <span data-testid={`stub-user-${id}`}>user {id}</span>}
      />
    );
    // Awaited PRESENT element first, then the absence.
    await expect.element(page.getByTestId('apps-transfer-pending')).toBeInTheDocument();
    await expect.element(page.getByTestId('stub-user-42')).toBeInTheDocument();
    expect(page.getByTestId('stub-transfer-picker').elements()).toHaveLength(0);
  });

  test('Cancel reports the pending offer’s id', async () => {
    const cancelled: string[] = [];
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[]}
        viewerUserId={OWNER_ID}
        pendingTransfer={{ id: 'aot_specific', toUserId: 42, expiresAt: new Date() }}
        onCancelTransfer={(id) => cancelled.push(id)}
      />
    );
    const cancel = page.getByTestId('apps-transfer-cancel');
    await expect.element(cancel).toBeInTheDocument();
    await userEvent.click(cancel.element());
    expect(cancelled).toEqual(['aot_specific']);
  });

  test('the Cancel control is disabled while a transfer mutation is in flight', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[]}
        viewerUserId={OWNER_ID}
        pendingTransfer={{ id: 'aot_1', toUserId: 42, expiresAt: new Date() }}
        onCancelTransfer={() => undefined}
        transferBusy
      />
    );
    await expect.element(page.getByTestId('apps-transfer-cancel')).toBeDisabled();
  });

  /**
   * 🔴 THE CONNECT-CLIENT REFUSAL, RENDERED WITH ITS REASON.
   *
   * A connect-linked off-site listing is refused at initiate AND again in-transaction at
   * accept, with a message that names the REASON (the credentials/split-ownership
   * consequence) rather than a remedy — there is no unlink path in the product, so the
   * string deliberately instructs nothing. Collapsing it into a generic "something went
   * wrong" would leave the owner with a control that fails forever and no way to learn
   * why, so the message is asserted VERBATIM against the server's own exported constant
   * rather than against a paraphrase.
   *
   * NOTE: this test drives the MUTATION-ERROR route (the prop), which still exists for
   * every other refusal reason. The connect-client case is now caught BEFORE submission —
   * see `src/tests/pages/apps/listing-collaborators-transfer.browser.test.tsx`, which
   * drives it from listing data with no prop at all.
   */
  test('🔴 a refusal renders inline, with the server’s reason intact', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={OFFSITE}
        rows={[]}
        viewerUserId={OWNER_ID}
        transferPicker={<div data-testid="stub-transfer-picker" />}
        transferErrorMessage={CONNECT_CLIENT_TRANSFER_REFUSAL}
      />
    );
    const error = page.getByTestId('apps-transfer-owner-error');
    await expect.element(error).toBeInTheDocument();
    await expect.element(error).toHaveTextContent(/linked to an OAuth application/i);
    // NOT `/cannot be transferred/i` — this Alert's `title` prop already spells that, so
    // the regex would match the chrome rather than the message. Assert on the body.
    await expect.element(error).toHaveTextContent(/split ownership/i);
    // 🔴 The message the SERVER will send, character for character — a paraphrase here
    // would let the copy drift out from under the assertion.
    await expect.element(error).toHaveTextContent(CONNECT_CLIENT_TRANSFER_REFUSAL);
  });

  test('no refusal ⇒ no error panel (awaited control first)', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[]}
        viewerUserId={OWNER_ID}
        transferPicker={<div data-testid="stub-transfer-picker" />}
      />
    );
    await expect.element(page.getByTestId('apps-transfer-owner-section')).toBeInTheDocument();
    expect(page.getByTestId('apps-transfer-owner-error').elements()).toHaveLength(0);
  });

  /**
   * The disclosure two sections up PROMISES that a collaborator cannot transfer the app.
   * This pins the promise and the control together — a panel that grew a transfer control
   * for editors would contradict its own copy.
   */
  test('the invite disclosure’s promise and the transfer control agree', async () => {
    renderWithProviders(
      <AppCollaboratorsPanelView
        role="owner"
        capabilities={ONSITE}
        rows={[]}
        viewerUserId={OWNER_ID}
        transferPicker={<div data-testid="stub-transfer-picker" />}
      />
    );
    await expect
      .element(page.getByTestId('apps-collaborators-invite-disclosure'))
      .toHaveTextContent(/cannot transfer the app/i);
    await expect.element(page.getByTestId('apps-transfer-owner-section')).toBeInTheDocument();
  });
});
