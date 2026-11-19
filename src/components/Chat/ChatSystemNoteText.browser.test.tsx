import { describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/component-setup';
import type * as IsClientProvider from '~/providers/IsClientProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import { ChatSystemNoteText } from '~/components/Chat/ChatSystemNoteText';
import { dealAcceptedChatLine } from '~/shared/utils/creator-service-deal-chat-line';
import { groupRenamedNote } from '~/shared/utils/chat';

// `CustomMarkdown` reads both of these, and the scaffold mounts neither provider.
vi.mock('~/providers/IsClientProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof IsClientProvider>()),
  useIsClient: () => true,
}));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, username: 'ann' }),
}));

async function renderNote(content: string, username?: string) {
  const screen = await renderWithProviders(
    <div data-testid="note">
      <ChatSystemNoteText content={content} username={username} />
    </div>
  );
  return screen.container.querySelector('[data-testid="note"]')!;
}

describe('ChatSystemNoteText', () => {
  // Notes stored before group names were escaped hold the name as typed.
  test.each([
    ['[Open](https://example.org/x)', 'Open'],
    ['[Open](//example.org/x)', 'Open'],
    ['[Open](/\\example.org/x)', 'Open'],
    ['[Open](/%2F%2Fexample.org/x)', 'Open'],
    ['[Open](/%5Cexample.org/x)', 'Open'],
    ['[Open](/%2f%2fexample.org/x)', 'Open'],
    ['[Open](/%5cexample.org/x)', 'Open'],
    ['[Open](</\t/example.org/x>)', 'Open'],
    ['<https://example.org/x>', 'https://example.org/x'],
  ])('renders a stored note naming the group %s as text, with no link', async (name, text) => {
    const note = await renderNote(`Group renamed to "${name}"`);
    expect(note.querySelector('a')?.outerHTML ?? null).toBeNull();
    expect(note.textContent).toBe(`Group renamed to "${text}"`);
  });

  test('keeps the link a server-written note carries to our own page', async () => {
    const note = await renderNote(
      dealAcceptedChatLine({ dealId: 7, sellerName: 'ann', title: 'Portrait' })
    );
    expect(note.querySelector('a')?.getAttribute('href')).toBe('/services/deals/7');
  });

  test.each(['[Open](/models/1) *now*', '<https://example.org/x>', 'a_b_c `x` \\ !#~|'])(
    'shows a group newly renamed to %s exactly as typed, with no link',
    async (name) => {
      const note = await renderNote(groupRenamedNote(name));
      expect(note.querySelector('a')?.outerHTML ?? null).toBeNull();
      expect(note.textContent).toBe(`Group renamed to "${name}"`);
    }
  );

  test('renders a plain note, and still says "You" for the reader', async () => {
    expect((await renderNote(groupRenamedNote('Weekend crew'))).textContent).toBe(
      'Group renamed to "Weekend crew"'
    );
    expect((await renderNote('ann was added', 'ann')).textContent).toBe('You were added');
  });
});
