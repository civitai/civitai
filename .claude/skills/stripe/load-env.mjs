/**
 * Minimal .env loader — no dependencies.
 * Walks up from the skill directory to find .env files.
 * Does NOT override existing env vars.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolved from THIS FILE, not the cwd. The second path used to be `process.cwd()/.env`,
// which meant the skill found its credentials only when invoked from the repo root and
// failed from any subdirectory or worktree with "env var is required" — a missing-config
// error that reads like a missing credential.
const projectRoot = path.resolve(__dirname, '../../..');

const ENV_PATHS = [
  path.resolve(__dirname, '.env'),
  path.resolve(projectRoot, '.env'),
  path.resolve(process.cwd(), '.env'),
];

for (const envPath of ENV_PATHS) {
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}
