import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/redis.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

const { getFilesByVersionIdHandler } = await import('~/server/controllers/model-file.controller');

/** `modelFile.getByVersionId`: the version's files follow the model page's visibility rules. */

const OWNER = 7;
const VERSION = 100;
const SCOPED_KEY = {
  apiKeyId: 1,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey', id: 1 },
  tokenScope: TokenScope.ModelsRead,
};
const VIEWERS = {
  anon: undefined,
  other: { id: 9, isModerator: false },
  owner: { id: OWNER, isModerator: false },
  moderator: { id: 1, isModerator: true },
} as const;
type ViewerKey = keyof typeof VIEWERS;

const FILES = [
  { id: 1, name: 'public.safetensors', type: 'Model', visibility: 'Public' },
  { id: 2, name: 'private.safetensors', type: 'Model', visibility: 'Private' },
  { id: 3, name: 'data.zip', type: 'Training Data', visibility: 'Private' },
].map((file) => ({ ...file, modelVersionId: VERSION, metadata: {}, hashes: [] }));

function arrange({
  versionStatus = 'Published',
  modelStatus = 'Published',
  poi = false,
  publishedAt = versionStatus === 'Published' ? new Date(0) : null,
}: {
  versionStatus?: string;
  modelStatus?: string;
  poi?: boolean;
  publishedAt?: Date | null;
} = {}) {
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
    status: versionStatus,
    publishedAt,
    model: { userId: OWNER, status: modelStatus, poi },
  } as never);
  dbMock.dbRead.modelFile.findMany.mockResolvedValue(structuredClone(FILES) as never);
}

async function fileNames(viewer: ViewerKey, credential = {}) {
  const data = await getFilesByVersionIdHandler({
    input: { id: VERSION },
    ctx: { user: VIEWERS[viewer], features: {}, ...credential },
  } as never);
  return data ? data.files.map((f: { name: string }) => f.name) : 'none';
}

beforeEach(() => arrange());

describe('modelFile.getByVersionId', () => {
  it.each<ViewerKey>(['anon', 'other'])(
    'gives %s the Public files and training data only',
    async (v) => {
      expect(await fileNames(v)).toEqual(['public.safetensors', 'data.zip']);
    }
  );

  it.each<ViewerKey>(['owner', 'moderator'])('gives %s every file', async (v) => {
    expect(await fileNames(v)).toEqual(['public.safetensors', 'private.safetensors', 'data.zip']);
  });

  it('gives the owner on a scoped key the Public files only, as anyone', async () => {
    expect(await fileNames('owner', SCOPED_KEY)).toEqual(['public.safetensors', 'data.zip']);
  });

  it.each([
    ['a draft version', { versionStatus: 'Draft' }],
    [
      'a version unpublished for a violation',
      { versionStatus: 'UnpublishedViolation', modelStatus: 'UnpublishedViolation' },
    ],
    ['a version of a poi model', { poi: true }],
    ['a deleted version', { versionStatus: 'Deleted', modelStatus: 'Deleted' }],
    ['a version of an unpublished model', { modelStatus: 'Unpublished' }],
    ['a draft version of a published model', { versionStatus: 'Draft', modelStatus: 'Published' }],
    ['a version scheduled to publish later', { publishedAt: new Date(Date.now() + 86_400_000) }],
  ])(
    'lists nothing of %s to another user, and everything to its owner and a moderator',
    async (_, state) => {
      arrange(state);
      expect(await fileNames('other')).toBe('none');
      expect(await fileNames('moderator')).toEqual([
        'public.safetensors',
        'private.safetensors',
        'data.zip',
      ]);
      expect(await fileNames('owner')).toEqual([
        'public.safetensors',
        'private.safetensors',
        'data.zip',
      ]);
    }
  );
});
