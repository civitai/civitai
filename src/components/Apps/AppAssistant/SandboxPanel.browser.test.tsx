import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ModalsProvider } from '@mantine/modals';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';
import type { SandboxesState } from '~/components/Apps/AppAssistant/useSandboxes';
import { SandboxPanel } from '~/components/Apps/AppAssistant/SandboxPanel';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const SANDBOX: Sandbox = {
  name: 'sbx-0123456789ab',
  app: 'my-app',
  state: 'running',
  mcpUrl: 'https://sandbox.example/s/sbx-0123456789ab/mcp',
  createdAt: null,
  lastActivityAt: null,
  expiresAt: '2026-10-25T00:00:00.000Z',
};

const remove = vi.fn();
const open = vi.fn();
const onRemoved = vi.fn();
let openError: unknown = null;

function state(): SandboxesState {
  const mutation = (mutate: unknown, error: unknown = null) => ({
    mutate,
    isPending: false,
    variables: undefined,
    error,
  });
  return {
    list: { data: [SANDBOX], isLoading: false, error: null },
    open: mutation(open, openError),
    suspend: mutation(vi.fn()),
    remove: mutation((name: string, opts?: { onSuccess?: () => void }) => {
      remove(name);
      opts?.onSuccess?.();
    }),
  } as unknown as SandboxesState;
}

async function mount() {
  renderWithProviders(
    <ModalsProvider>
      <SandboxPanel
        sandboxes={state()}
        activeName={null}
        onOpened={vi.fn()}
        onRemoved={onRemoved}
      />
    </ModalsProvider>
  );
  await expect.element(page.getByText('my-app', { exact: true })).toBeInTheDocument();
}

beforeEach(() => {
  remove.mockClear();
  open.mockClear();
  onRemoved.mockClear();
  openError = null;
});

describe('SandboxPanel', () => {
  test('deletes only after the confirmation, and reports which sandbox went', async () => {
    await mount();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.element(page.getByRole('button', { name: 'Delete sandbox' })).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Delete sandbox' }).click();
    expect(remove).toHaveBeenCalledWith(SANDBOX.name);
    expect(onRemoved).toHaveBeenCalledWith(SANDBOX.name);
  });

  test('keeping the sandbox deletes nothing', async () => {
    await mount();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Keep it' }).click();
    expect(remove).not.toHaveBeenCalled();
  });

  test('refuses an empty app name before calling the service, and opens a valid one', async () => {
    await mount();
    await page.getByRole('button', { name: 'Open sandbox' }).click();
    await expect.element(page.getByText('Enter a name for the app')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();

    await page.getByRole('textbox', { name: 'App name' }).fill('  other-app  ');
    await page.getByRole('button', { name: 'Open sandbox' }).click();
    expect(open).toHaveBeenCalledWith('other-app', expect.anything());
  });

  test('shows a limit refusal as a limit, with the service message', async () => {
    openError = new SandboxApiError('sandbox limit (3) reached; delete one first', 409, 'limit');
    await mount();
    await expect.element(page.getByText('Sandbox limit reached')).toBeInTheDocument();
    await expect
      .element(page.getByText(/sandbox limit \(3\) reached; delete one first/))
      .toBeInTheDocument();
  });
});
