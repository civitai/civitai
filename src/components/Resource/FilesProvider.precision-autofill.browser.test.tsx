import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The wiring, not the rule. `resolveUploadPrecision` is covered by
 * `src/utils/__tests__/file-helpers.precision-filename-fallback.test.ts`; what nothing else
 * reaches is the three lines in `onDrop` that carry its answer into the file record.
 *
 * 🔑 The name reaches it with its ORIGINAL case on purpose. The extension check just above
 * lowercases into a local, and passing that local instead — which reads like an obvious tidy —
 * silently kills every camelCase match, because the word-start rule needs the hump. A unit test
 * calling the helper directly cannot see that; this one can, which is the reason it exists.
 *
 * No `version` is passed, so the auto-start upload effect returns early: this test transfers no
 * bytes and touches no S3.
 *
 * Each case waits for the field to STOP being empty and then asserts the value synchronously,
 * rather than polling for the right value. Both arrive on the same tick, so polling for the value
 * would burn the full 15 s matcher budget on every wrong answer and report it as a slow test —
 * `expected nvfp4, received fp32` in 15 s reads like an environment problem. This way a wrong
 * value fails in under a second, saying the same thing.
 */

const noMutation = vi.hoisted(() => () => ({
  mutateAsync: vi.fn(),
  mutate: vi.fn(),
  isLoading: false,
}));

// Only the `trpc` client is overridden; the module's other exports are kept via importOriginal
// so a consumer elsewhere in the tree doesn't get `undefined` and silently collect zero tests.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({ modelFile: { hasOfficialFileOfSize: { fetch: vi.fn() } } }),
    // Undefined data makes useModelFileOptions fall back to constants.modelFileFp, which is the
    // real list this runs against in production until the query resolves.
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

import { FilesProvider, useFilesContext } from '~/components/Resource/FilesProvider';

/** Real production header of ModelFile 3157252, MNeMiC's own NVFP4 checkpoint. */
const NVFP4_HEADER: Array<[string, number, number]> = [
  ['U8', 448, 6_077_550_752],
  ['F32', 239, 1_280_582_832],
  ['F8_E4M3', 224, 759_693_312],
  ['BF16', 191, 689_669_120],
];

function safetensorsFile(name: string, dtypes: Array<[string, number, number]>) {
  const header: Record<string, { dtype: string; data_offsets: [number, number] }> = {};
  let offset = 0;
  for (const [dtype, count, bytes] of dtypes) {
    const per = Math.floor(bytes / count);
    for (let i = 0; i < count; i++) {
      header[`${dtype}.${i}`] = { dtype, data_offsets: [offset, offset + per] };
      offset += per;
    }
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(8);
  new DataView(len.buffer).setBigUint64(0, BigInt(json.byteLength), true);
  return new File([len, json], name);
}

function Harness({ file }: { file: File }) {
  const { files, onDrop } = useFilesContext();
  return (
    <div>
      <button onClick={() => onDrop([file])}>drop</button>
      <span data-testid="fp">{files[0]?.fp ?? 'none'}</span>
    </div>
  );
}

function renderHarness(file: File) {
  renderWithProviders(
    <FilesProvider model={{ type: 'Checkpoint' }}>
      <Harness file={file} />
    </FilesProvider>
  );
}

/** Drop the file, wait for detection to settle, and return whatever it settled on. */
async function dropAndReadPrecision() {
  await page.getByRole('button', { name: 'drop' }).click();
  const field = page.getByTestId('fp');
  await expect.element(field).not.toHaveTextContent('none');
  return field.element().textContent;
}

describe('FilesProvider auto-fills precision from the name when the header cannot state it', () => {
  test("MNeMiC's NVFP4 checkpoint lands as nvfp4, not the fp32 its header votes for", async () => {
    renderHarness(safetensorsFile('KREAtivity_5.0_NVFP4.safetensors', NVFP4_HEADER));

    expect(await dropAndReadPrecision()).toBe('nvfp4');
  });

  test('a camelCase name still matches, which is what breaks if the lowercased local is passed', async () => {
    renderHarness(safetensorsFile('RawGirlKreaNVFP4.safetensors', NVFP4_HEADER));

    expect(await dropAndReadPrecision()).toBe('nvfp4');
  });

  test('a header that can speak still wins over a name claiming a dtype-stateable precision', async () => {
    renderHarness(safetensorsFile('some_model_fp8.safetensors', [['BF16', 4, 4_000_000]]));

    expect(await dropAndReadPrecision()).toBe('bf16');
  });
});
