import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';
import { createInterface } from 'readline';

/**
 * Streams line by line: a predictions file outgrows V8's single-string limit
 * (~512M chars) within months of daily runs. A parse error names the line
 * number only, because manifest lines carry user state.
 */
export async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  const rows: T[] = [];
  let lineNo = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`${path}: line ${lineNo} is not valid JSON`);
    }
  }
  return rows;
}

/** Write-then-rename, so a crash never leaves a half-written file. */
export function writeFileAtomic(path: string, contents: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function toJsonl(rows: readonly unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

export function writeJsonl(path: string, rows: readonly unknown[]): void {
  writeFileAtomic(path, toJsonl(rows));
}

export function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;
}
