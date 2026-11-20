import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  readContentCredentials,
  VerifyUnavailableError,
} from '~/server/services/content-credentials.service';

describe('readContentCredentials when the reader cannot load', () => {
  // A broken deploy must answer "retry", never a verdict about the user's file.
  it('rejects with VerifyUnavailableError instead of reporting the file unreadable', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(tmpdir());
    await expect(
      readContentCredentials(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg')
    ).rejects.toBeInstanceOf(VerifyUnavailableError);
  });
});
