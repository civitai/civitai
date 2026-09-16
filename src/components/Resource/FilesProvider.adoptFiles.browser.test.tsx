import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useS3UploadStore } from '~/store/s3-upload.store';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * `adoptFiles` is the only way a file created outside this provider reaches `files`, and nothing
 * else in the suite exercises the real one.
 *
 * The fixture is deliberately un-permissive: populated metadata, a distinct `overrideName`, and a
 * real pending row seeded through the provider's own upload-store path. A fixture where every
 * mapped field is `undefined` cannot observe a mapping that drops one.
 */

const noMutation = vi.hoisted(() => () => ({
  mutateAsync: vi.fn(),
  mutate: vi.fn(),
  isLoading: false,
}));

const { mockForEditFetch } = vi.hoisted(() => ({ mockForEditFetch: vi.fn() }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      modelFile: { hasOfficialFileOfSize: { fetch: vi.fn() } },
      modelVersion: { getByIdForEdit: { fetch: mockForEditFetch } },
    }),
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
vi.mock('~/hooks/useFileHash', () => ({ useFileHash: () => ({ hashFile: vi.fn() }) }));
vi.mock('~/components/Resource/official-match', () => ({ resolveOfficialFileHash: vi.fn() }));

import type { FileFromContextProps } from '~/components/Resource/FilesProvider';
import { FilesProvider, useFilesContext } from '~/components/Resource/FilesProvider';

const VERSION_ID = 42;

/** A server row with every mapped field populated, so a dropped or swapped field is observable. */
const serverFile = (id: number, name: string) => ({
  id,
  name,
  overrideName: `${name}-override`,
  type: 'Model',
  sizeKB: 1024,
  metadata: {
    size: 'pruned',
    fp: 'fp16',
    format: 'SafeTensor',
    quantType: 'Q8_0',
    isRequired: true,
  },
});

/** Every field `toFileFromContext` maps, serialised so one `toBe` pins the whole row. */
const project = (file: FileFromContextProps) =>
  [
    file.name,
    file.overrideName,
    file.type,
    file.fp,
    file.format,
    file.size,
    file.quantType,
    file.isRequired,
    file.sizeKB,
    file.versionId,
    file.modelType,
  ]
    .map((value) => value ?? '-')
    .join('|');

/** What `project` prints for a `serverFile` mapped under this harness's version and model. */
const row = (name: string, fp = 'fp16') =>
  `${name}|${name}-override|Model|${fp}|SafeTensor|pruned|Q8_0|true|1024|${VERSION_ID}|Checkpoint`;

function Harness({ adopt }: { adopt: number[] }) {
  const { files, adoptFiles, updateFile } = useFilesContext();
  return (
    <div>
      <button onClick={() => void adoptFiles(adopt)}>adopt</button>
      {/* An edit held in provider state and not yet saved — what a creator mid-form has. */}
      <button onClick={() => files[0] && updateFile(files[0].uuid, { fp: 'bf16' })}>edit</button>
      <span data-testid="files">{files.map(project).join(' / ') || 'none'}</span>
      <span data-testid="uuids">{files.map((file) => file.uuid).join(',')}</span>
    </div>
  );
}

function renderHarness({
  versionFiles = [] as unknown[],
  adopt = [] as number[],
  pending = false,
} = {}) {
  if (pending)
    // Through the provider's real pending-row path (it reads the upload store when it seeds).
    useS3UploadStore.setState({
      items: [
        {
          name: 'pending.safetensors',
          size: 2048,
          file: new File([], 'pending.safetensors'),
          meta: { versionId: VERSION_ID, uuid: 'pending-uuid', type: 'Model' },
        },
      ] as never,
    });

  renderWithProviders(
    <FilesProvider
      model={{ id: 1, type: 'Checkpoint' }}
      version={{ id: VERSION_ID, files: versionFiles as never, baseModel: 'Flux.1 D' }}
    >
      <Harness adopt={adopt} />
    </FilesProvider>
  );
}

const filesText = () => page.getByTestId('files').element().textContent;
const uuidsText = () => page.getByTestId('uuids').element().textContent ?? '';

/** Budget trimmed from 15 s: the state is ABSORBING, so a revert reports in 2 s. */
const untilAdopted = (name: string) =>
  expect.element(page.getByTestId('files'), { timeout: 2000 }).toHaveTextContent(name);

async function editFirstRow() {
  await page.getByRole('button', { name: 'edit' }).click();
  await expect.element(page.getByTestId('files')).toHaveTextContent('|bf16|');
}

beforeEach(() => {
  mockForEditFetch.mockReset();
  // Module-scope store, shared across every test in this file.
  useS3UploadStore.setState({ items: [] as never });
});

describe('FilesProvider.adoptFiles', () => {
  test('adds a named file with every mapped field, and asks for the files', async () => {
    renderHarness({ versionFiles: [], adopt: [8] });
    mockForEditFetch.mockResolvedValue({ files: [serverFile(8, 'imported.safetensors')] });

    await page.getByRole('button', { name: 'adopt' }).click();
    await untilAdopted('imported.safetensors');

    expect(filesText()).toBe(row('imported.safetensors'));
    // The REQUEST, not the mock's answer: `withFiles: false` returns no files, so the list would
    // never update — invisible if only the response is read.
    expect(mockForEditFetch).toHaveBeenCalledTimes(1);
    expect(mockForEditFetch).toHaveBeenCalledWith({ id: VERSION_ID, withFiles: true });
  });

  test('adopts ONLY the ids it was given', async () => {
    renderHarness({ versionFiles: [], adopt: [8] });
    mockForEditFetch.mockResolvedValue({
      files: [serverFile(8, 'imported.safetensors'), serverFile(9, 'someone-elses.safetensors')],
    });

    await page.getByRole('button', { name: 'adopt' }).click();
    await untilAdopted('imported.safetensors');

    expect(filesText()).toBe(row('imported.safetensors'));
  });

  test('leaves an existing row untouched, including edits not yet saved', async () => {
    renderHarness({ versionFiles: [serverFile(7, 'existing.safetensors')], adopt: [8] });
    // The server still reports the ORIGINAL precision; state holds the unsaved edit.
    mockForEditFetch.mockResolvedValue({
      files: [serverFile(7, 'existing.safetensors'), serverFile(8, 'imported.safetensors')],
    });

    await editFirstRow();
    const [existingUuid] = uuidsText().split(',');
    await page.getByRole('button', { name: 'adopt' }).click();
    await untilAdopted('imported.safetensors');

    expect(filesText()).toBe(
      `${row('existing.safetensors', 'bf16')} / ${row('imported.safetensors')}`
    );
    // `Files.tsx` binds upload progress and the edit form's dirty baseline to the uuid.
    expect(uuidsText().split(',')[0]).toBe(existingUuid);
  });

  test('keeps a file still uploading, which the server cannot report', async () => {
    renderHarness({
      versionFiles: [serverFile(7, 'existing.safetensors')],
      adopt: [8],
      pending: true,
    });
    mockForEditFetch.mockResolvedValue({
      files: [serverFile(7, 'existing.safetensors'), serverFile(8, 'imported.safetensors')],
    });

    await page.getByRole('button', { name: 'adopt' }).click();
    await untilAdopted('imported.safetensors');

    expect(filesText()).toContain('pending.safetensors');
  });

  test('re-naming a file the list already holds neither duplicates nor rebuilds it', async () => {
    renderHarness({ versionFiles: [serverFile(7, 'existing.safetensors')], adopt: [7, 8] });
    mockForEditFetch.mockResolvedValue({
      files: [serverFile(7, 'existing.safetensors'), serverFile(8, 'imported.safetensors')],
    });

    await editFirstRow();
    const [existingUuid] = uuidsText().split(',');
    await page.getByRole('button', { name: 'adopt' }).click();
    await untilAdopted('imported.safetensors');

    // Rebuilding id 7 from the server would revert the edit and mint a new uuid.
    expect(filesText()).toBe(
      `${row('existing.safetensors', 'bf16')} / ${row('imported.safetensors')}`
    );
    expect(uuidsText().split(',')[0]).toBe(existingUuid);
  });

  test('keeps an edit made while the fetch was in flight', async () => {
    renderHarness({ versionFiles: [serverFile(7, 'existing.safetensors')], adopt: [8] });
    let resolveFetch!: (value: unknown) => void;
    mockForEditFetch.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));

    await page.getByRole('button', { name: 'adopt' }).click();
    await expect.poll(() => mockForEditFetch.mock.calls.length).toBe(1);
    await editFirstRow();
    resolveFetch({
      files: [serverFile(7, 'existing.safetensors'), serverFile(8, 'imported.safetensors')],
    });
    await untilAdopted('imported.safetensors');

    // Building from the list as it was when `adoptFiles` was called would drop the edit.
    expect(filesText()).toBe(
      `${row('existing.safetensors', 'bf16')} / ${row('imported.safetensors')}`
    );
  });

  test('asks for nothing when no ids were created', async () => {
    renderHarness({ versionFiles: [serverFile(7, 'existing.safetensors')], adopt: [] });

    await page.getByRole('button', { name: 'adopt' }).click();
    await expect.element(page.getByTestId('files')).toHaveTextContent('existing.safetensors');
    expect(mockForEditFetch).not.toHaveBeenCalled();
  });
});
