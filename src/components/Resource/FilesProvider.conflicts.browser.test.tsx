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

type SeedFile = { id: number; name: string; sizeKB: number; sha256: string | null; fp?: string };

const seed = ({ id, name, sizeKB, sha256, fp = 'int8' }: SeedFile) => ({
  id,
  name,
  sizeKB,
  hashes: sha256 ? [{ type: 'SHA256', hash: sha256 }] : [],
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

const fl2va = { id: 1, name: 'fl2va_bf16.safetensors', sizeKB: 64727038, fp: 'bf16' };
const ref2va = { id: 2, name: 'ref2va_bf16.safetensors', sizeKB: 64727038, fp: 'bf16' };
const int8 = { id: 3, name: 'fl2va_int8.safetensors', sizeKB: 33241106 };
const int8Pruned = { id: 4, name: 'fl2va_pruned_int8.safetensors', sizeKB: 20478886 };

describe('FilesProvider save-time similar-files check', () => {
  beforeEach(() => {
    showErrorNotification.mockClear();
    showWarningNotification.mockClear();
  });

  test('variants of the exact same size and settings save with a warning', async () => {
    renderVersion([fl2va, ref2va]);

    expect(await validate('all')).toBe('true');
    expect(await validate(ref2va.name)).toBe('true');
    expect(showWarningNotification).toHaveBeenCalledTimes(2);
    expect(showErrorNotification).not.toHaveBeenCalled();
  });

  test('a per-file save only warns about groups that file is part of', async () => {
    renderVersion([fl2va, ref2va, int8]);

    expect(await validate(int8.name)).toBe('true');
    expect(showWarningNotification).not.toHaveBeenCalled();
  });

  test('a version save warns about every similar group', async () => {
    renderVersion([fl2va, ref2va, int8, int8Pruned]);

    expect(await validate('all')).toBe('true');
    expect(showWarningNotification).toHaveBeenCalledTimes(1);
    expect(showErrorNotification).not.toHaveBeenCalled();
  });
});
