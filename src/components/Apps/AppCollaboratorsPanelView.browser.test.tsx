import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { CollaboratorRosterRow } from '~/components/Apps/AppCollaboratorsPanelView';
import { AppCollaboratorsPanelView } from '~/components/Apps/AppCollaboratorsPanelView';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';

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
