import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';

const noMutation = vi.hoisted(() => () => ({
  mutateAsync: vi.fn(),
  mutate: vi.fn(),
  isLoading: false,
}));
const { showErrorNotification, showWarningNotification } = vi.hoisted(() => ({
  showErrorNotification: vi.fn(),
  showWarningNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({ modelFile: { hasOfficialFileOfSize: { fetch: vi.fn() } } }),
    modelFile: {
      getOptions: { useQuery: () => ({ data: undefined }) },
      create: { useMutation: noMutation },
    },
    modelVersion: {
      setLinkedComponents: { useMutation: noMutation },
      linkOfficialFileByHash: { useMutation: noMutation },
      addLinkedComponent: { useMutation: noMutation },
      publish: { useMutation: noMutation },
    },
    model: { publish: { useMutation: noMutation } },
  },
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification,
  showWarningNotification,
}));
vi.mock('~/hooks/useFileHash', () => ({ useFileHash: () => ({ hashFile: vi.fn() }) }));
vi.mock('~/components/Resource/official-match', () => ({ resolveOfficialFileHash: vi.fn() }));

import { FilesProvider, useFilesContext } from '~/components/Resource/FilesProvider';

type SeedFile = { id: number; name: string; sizeKB: number; fp?: string };

const seed = ({ id, name, sizeKB, fp = 'int8' }: SeedFile) => ({
  id,
  name,
  sizeKB,
  type: 'Model',
  metadata: { fp, format: 'SafeTensor' },
});

function Harness() {
  const { files, validationCheck } = useFilesContext();
  return (
    <div>
      <button onClick={(e) => (e.currentTarget.dataset.result = String(validationCheck()))}>
        all
      </button>
      {files.map((f) => (
        <button
          key={f.uuid}
          onClick={(e) => (e.currentTarget.dataset.result = String(validationCheck(f.uuid)))}
        >
          {f.name}
        </button>
      ))}
    </div>
  );
}

function renderVersion(files: SeedFile[]) {
  renderWithProviders(
    <FilesProvider
      model={{ type: 'Checkpoint' }}
      version={{ id: 1, files: files.map(seed) as never }}
    >
      <Harness />
    </FilesProvider>
  );
}

async function validate(name: string) {
  const button = page.getByRole('button', { name, exact: true });
  await button.click();
  return (button.element() as HTMLElement).dataset.result;
}

const fl2va = { id: 1, name: 'fl2va_int8.safetensors', sizeKB: 33241106 };
const ref2va = { id: 2, name: 'ref2va_pruned_int8.safetensors', sizeKB: 20478886 };
const copy = { id: 3, name: 'fl2va_int8_copy.safetensors', sizeKB: 33241106 };
const bf16 = { id: 4, name: 'fl2va_bf16.safetensors', sizeKB: 64727038, fp: 'bf16' };

describe('FilesProvider save-time conflict check', () => {
  beforeEach(() => {
    showErrorNotification.mockClear();
    showWarningNotification.mockClear();
  });

  test('variants sharing type and precision save with a warning', async () => {
    renderVersion([fl2va, ref2va]);

    expect(await validate('all')).toBe('true');
    expect(await validate(fl2va.name)).toBe('true');
    expect(showWarningNotification).toHaveBeenCalledTimes(2);
    expect(showErrorNotification).not.toHaveBeenCalled();
  });

  test('the same file twice blocks the version save', async () => {
    renderVersion([fl2va, copy]);

    expect(await validate('all')).toBe('false');
    expect(showErrorNotification).toHaveBeenCalledTimes(1);
  });

  test('a per-file save is blocked only by a duplicate that file is part of', async () => {
    renderVersion([fl2va, copy, ref2va, bf16]);

    expect(await validate(copy.name)).toBe('false');
    expect(await validate(bf16.name)).toBe('true');
    expect(showWarningNotification).not.toHaveBeenCalled();
  });

  test('a variant in a group that also holds a duplicate is still warned about', async () => {
    renderVersion([fl2va, copy, ref2va]);

    expect(await validate(ref2va.name)).toBe('true');
    expect(showWarningNotification).toHaveBeenCalledTimes(1);
  });
});
