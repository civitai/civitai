import { readFileSync } from 'fs';
import path from 'path';

export const RUN_JOBS_ROUTE = path.resolve(
  __dirname,
  '../../../pages/api/webhooks/run-jobs/[[...run]].ts'
);

/**
 * The `jobs` array the route dispatches on, one entry per line, comments dropped.
 *
 * Read rather than imported: importing that route pulls in every job in the application, which is
 * most of the server. The claim is about one line of a list, and a list is something a file can be
 * asked about directly.
 */
export function jobsArrayEntries(): string[] {
  const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');
  const start = source.indexOf('export const jobs: Job[] = [');
  if (start === -1) throw new Error(`no \`jobs\` array in ${RUN_JOBS_ROUTE}`);
  const end = source.indexOf('\n];', start);
  if (end === -1) throw new Error(`unterminated \`jobs\` array in ${RUN_JOBS_ROUTE}`);
  return (
    source
      .slice(start, end)
      .split('\n')
      // A trailing `// daily` on a live entry must not read as the entry being gone.
      .map((line) =>
        line
          .replace(/\s*\/\/.*$/, '')
          .trim()
          .replace(/,$/, '')
      )
      .filter((line) => line.length > 0)
  );
}
