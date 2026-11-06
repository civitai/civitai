import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as DialogProviderModule from '~/components/Dialog/DialogProvider';
import type * as HiddenPreferencesModule from '~/hooks/hidden-preferences';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

type MutationOptions = {
  onMutate?: (variables: unknown) => void;
  onSuccess?: (data: unknown, variables: unknown) => Promise<void> | void;
  onSettled?: () => void;
};

const mocks = vi.hoisted(() => ({
  reportCreate: vi.fn(),
  addTagVotes: vi.fn(),
  removeTagVotes: vi.fn(),
  setVotableTags: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('next/router', () => ({
  useRouter: () => ({ query: {}, asPath: '/', push: vi.fn() }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogProviderModule>()),
  useDialogContext: () => ({ opened: true, onClose: mocks.onClose, id: 'report' }),
}));
vi.mock('~/hooks/hidden-preferences', async (importOriginal) => ({
  ...(await importOriginal<typeof HiddenPreferencesModule>()),
  useHiddenPreferencesData: () => ({ hiddenTags: [] }),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'report.create': {
        useMutation: (options: MutationOptions) => ({
          isPending: false,
          mutate: async (variables: unknown) => {
            mocks.reportCreate(variables);
            options.onMutate?.(variables);
            await options.onSuccess?.(undefined, variables);
            options.onSettled?.();
          },
        }),
      },
      'tag.addTagVotes': { useMutation: () => ({ mutate: mocks.addTagVotes }) },
      'tag.removeTagVotes': { useMutation: () => ({ mutate: mocks.removeTagVotes }) },
    },
    {
      useUtils: () => ({
        tag: { getVotableTags: { setData: mocks.setVotableTags } },
        hiddenPreferences: { getHidden: { setData: vi.fn() } },
      }),
    }
  ),
}));

import ReportModal from '~/components/Modals/ReportModal';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { ReportReason } from '~/shared/utils/prisma/enums';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReportModal NSFW image report', () => {
  test('files the tags with the report and shows them without a separate tag vote', async () => {
    renderWithProviders(
      <ReportModal entityType={ReportEntity.Image} entityId={42} reportKey="nsfw-image" />
    );

    await userEvent.click(page.getByText('Partial Nudity'));
    await userEvent.click(page.getByRole('button', { name: 'Submit' }));

    await vi.waitFor(() => expect(mocks.onClose).toHaveBeenCalled());
    expect(mocks.reportCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ReportEntity.Image,
        reason: ReportReason.NSFW,
        id: 42,
        details: expect.objectContaining({ tags: ['partial nudity'] }),
      })
    );
    expect(mocks.addTagVotes).not.toHaveBeenCalled();
    expect(mocks.removeTagVotes).not.toHaveBeenCalled();
    expect(mocks.setVotableTags).toHaveBeenCalledWith(
      { id: 42, type: 'image' },
      expect.any(Function)
    );
  });
});
