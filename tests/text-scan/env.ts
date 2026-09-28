import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { parseE2eEnv, type E2eEnv } from './logic';

export const E2E_ENV_FILE = path.resolve('tests/text-scan/local/e2e.env');

let cached: E2eEnv | undefined;

export function e2eEnv(): E2eEnv {
  cached ??= parseE2eEnv(
    process.env,
    fs.existsSync(E2E_ENV_FILE) ? dotenv.parse(fs.readFileSync(E2E_ENV_FILE)) : {},
    E2E_ENV_FILE
  );
  return cached;
}
