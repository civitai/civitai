import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { BOT_CACHE_ROUTES } from '~/server/bot-cache/bot-cache';

/**
 * The region-free flags and the failed-prefetch mark of a bot-cache render are applied by
 * `createServerSideProps` (`~/server/utils/server-side-helpers`), and the render tests go through
 * only some of the allowlisted pages. So every allowlisted route must be a page file whose
 * `getServerSideProps` is built with it: a page that defines its own would hand the flag evaluation
 * the request (and its region) and never mark a failed prefetch, and still be cached.
 */

const PAGES_DIR = path.join(process.cwd(), 'src/pages');
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

/** The file Next builds `pattern` from, or `null`. */
function pageFile(pattern: string): string | null {
  const base = path.join(PAGES_DIR, pattern);
  const candidates = EXTENSIONS.flatMap((ext) => [base + ext, path.join(base, 'index' + ext)]);
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

const DEFINITION =
  /export\s+(?:async\s+)?(?:const|let|var|function)\s+getServerSideProps\b|export\s*\{[^}]*\bgetServerSideProps\b/g;
const BUILT_WITH_HELPER = /export\s+const\s+getServerSideProps\s*=\s*createServerSideProps\s*[(<]/;

/** Why `source` does not build its getServerSideProps with createServerSideProps, or `null`. */
function getServerSidePropsProblem(source: string): string | null {
  const definitions = source.match(DEFINITION) ?? [];
  if (definitions.length !== 1) return `${definitions.length} getServerSideProps definitions`;
  if (!BUILT_WITH_HELPER.test(source)) return `defined another way: ${definitions[0]}`;
  return null;
}

describe('every BOT_CACHE_ROUTES page is rendered through createServerSideProps', () => {
  it.each(Object.keys(BOT_CACHE_ROUTES))('%s', (pattern) => {
    const file = pageFile(pattern);
    expect(file, `no page file for ${pattern}`).not.toBeNull();
    expect(getServerSidePropsProblem(fs.readFileSync(file!, 'utf8'))).toBeNull();
  });
});

describe('INSTRUMENT CHECK: the guard can fail', () => {
  it('finds no file for a route that is not a page', () => {
    expect(pageFile('/models/[id]/no-such-tab')).toBeNull();
    // ...and does find one the same way for a route that is.
    expect(pageFile('/user/[username]')).toMatch(/user\/\[username\]\/index\.tsx$/);
  });

  it.each([
    ['an own function', 'export async function getServerSideProps() { return { props: {} }; }'],
    ['an own const', 'export const getServerSideProps = async () => ({ props: {} });'],
    ['a re-export', "export { getServerSideProps } from '~/elsewhere';"],
    ['none at all', 'export default function Page() { return null; }'],
  ])('rejects %s', (_, source) => {
    expect(getServerSidePropsProblem(source)).not.toBeNull();
  });

  it('accepts the helper form', () => {
    expect(
      getServerSidePropsProblem(
        'export const getServerSideProps = createServerSideProps({ resolver: async () => ({}) });'
      )
    ).toBeNull();
  });
});
