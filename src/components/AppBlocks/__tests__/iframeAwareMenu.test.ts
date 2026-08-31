import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY `<Menu>` in the app-block host chrome must be iframe-aware. Node `unit`
 * project — the GATING tier. The behavioural proof lives in
 * `AppBlockChrome.browser.test.tsx`, which runs in CI as the REPORT-ONLY
 * `preview / component-tests` status; this is the copy that can block a merge.
 *
 * WHAT BROKE. `AppBlockChrome` renders two Mantine menus a hundred lines apart.
 * The platform-nav one was made CONTROLLED with a window-`blur` close, because
 * the cross-origin app iframe below swallows the `mousedown` of a click into the
 * app and Mantine's `closeOnClickOutside` therefore never fires. The ⋮ overflow
 * menu — same component, same iframe, same hazard — was left a bare uncontrolled
 * `<Menu>` and stayed open on top of the app the user had just clicked into.
 *
 * Nothing about the second menu looked wrong; the rule simply lived at one site
 * and the other site was written without it. So the cure is a shared hook
 * (`useIframeAwareMenu`) plus this LEDGER, which fails when the set of menus in
 * the chrome GROWS (a new control added without the hook) or SHRINKS (a menu
 * removed, or the hook quietly reverted to inline state) — not a presence check
 * that a third uncontrolled menu would sail past.
 *
 * 🔴 THIS IS A SOURCE SCAN, AND IT PINS A RELATIONSHIP, NOT A WORD. It asserts
 * that the count of `<Menu …>` opening tags inside `AppBlockChrome` equals the
 * count of hook calls AND that every one of those tags carries both `opened=` and
 * `onChange=`. A menu that spells `opened` from some other state still fails the
 * count, and a hook call with no menu fails it in the other direction.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const HOST = path.join(REPO_ROOT, 'src/components/AppBlocks/IframeHost.tsx');
const HOOK = path.join(REPO_ROOT, 'src/components/AppBlocks/useIframeAwareMenu.ts');

function read(file: string): string {
  // Prove the path before trusting any "no match" below: a scan of an absent
  // file reports zero of everything, which would read as a clean pass.
  expect(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** Strip block + line comments — every token searched for below is also
 *  discussed at length in the comments around it, so a rule must never be
 *  satisfiable by prose ABOUT the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The `AppBlockChrome` function body, bounded by the NEXT top-level
 * `export function` in the file. `IframeHost.tsx` also exports `IframeHost`,
 * which renders no chrome menus of its own — scoping keeps this guard about the
 * chrome rather than about the whole 5k-line module.
 */
function chromeSource(): string {
  const src = code(read(HOST));
  const start = src.indexOf('export function AppBlockChrome');
  expect(
    start,
    'the `AppBlockChrome` declaration was not found in IframeHost.tsx — if it moved or was ' +
      'renamed, re-point this guard rather than deleting it: it is the only BLOCKING check that ' +
      'every chrome menu is iframe-aware.'
  ).toBeGreaterThan(-1);
  const rest = src.slice(start + 'export function AppBlockChrome'.length);
  const nextExport = rest.indexOf('\nexport function ');
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

/** Opening `<Menu …>` tags only — `<Menu.Item>` / `<Menu.Dropdown>` / `<Menu.Label>`
 *  are sub-components, not menus, and closing tags are not openings. */
function menuOpeningTags(src: string): string[] {
  return [...src.matchAll(/<Menu(?![.\w])[\s\S]*?>/g)].map((m) => m[0]);
}

describe('every Menu in the app-block chrome is iframe-aware', () => {
  it('the scanner can actually see a menu — positive control on the regex itself', () => {
    // A ledger built on a regex that matches nothing reports a confident, empty,
    // fully-green set. Feed the matcher a shape it MUST find before believing any
    // count it returns from the real file.
    const fixture = `
      <Menu position="bottom-end" opened={x.opened} onChange={x.onChange}>
        <Menu.Target><button /></Menu.Target>
        <Menu.Dropdown><Menu.Item>a</Menu.Item></Menu.Dropdown>
      </Menu>
    `;
    const found = menuOpeningTags(fixture);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('position="bottom-end"');
    // …and that it does NOT count the sub-components, which is the whole reason
    // for the `(?![.\w])` guard.
    expect(menuOpeningTags('<Menu.Item>x</Menu.Item><Menu.Dropdown />')).toHaveLength(0);
  });

  it('the shared hook exists and is the only place the blur listener lives', () => {
    const hook = code(read(HOOK));
    expect(hook).toMatch(/export function useIframeAwareMenu/);
    expect(hook).toMatch(/addEventListener\(\s*'blur'/);

    // 🔴 ONE listener, one place. The original defect was this effect existing at
    // one site and not the other; a second inline copy in the chrome would be the
    // same defect re-forming, so the chrome must not grow its own.
    const chrome = chromeSource();
    expect(
      chrome.match(/addEventListener\(\s*'blur'/g) ?? [],
      'a window `blur` listener has reappeared INSIDE AppBlockChrome. That is the copy this ' +
        'consolidation removed — route the new control through `useIframeAwareMenu` instead.'
    ).toHaveLength(0);
  });

  it('the chrome renders exactly TWO menus, and both are on the hook', () => {
    const chrome = chromeSource();
    const tags = menuOpeningTags(chrome);

    // The LEDGER. Failing on GROWTH is the point: a third menu added to this
    // chrome must be a deliberate edit here, which is the moment somebody reads
    // the paragraph above and wires the hook. Failing on SHRINK catches a menu
    // being removed or replaced with something this guard can no longer see.
    expect(
      tags.length,
      'expected exactly TWO `<Menu>`s in AppBlockChrome — the platform-nav menu behind the app ' +
        'icon and the ⋮ overflow menu. A THIRD means a new control was added: put it on ' +
        '`useIframeAwareMenu` and update this count in the same commit, or it will be stuck open ' +
        'the first time a user clicks into the app. FEWER means one was removed or restructured ' +
        'past this scanner — re-point the guard deliberately.'
    ).toBe(2);

    // Every one of them is CONTROLLED. A count alone would pass two menus that
    // both dropped their `opened`/`onChange`.
    for (const tag of tags) {
      const oneLine = tag.replace(/\s+/g, ' ');
      expect(oneLine, `an uncontrolled <Menu> in AppBlockChrome: ${oneLine}`).toMatch(/opened=\{/);
      expect(oneLine, `a <Menu> with no onChange in AppBlockChrome: ${oneLine}`).toMatch(
        /onChange=\{/
      );
    }

    // …and the control state comes from the SHARED hook, once per menu. Two menus
    // and one hook call would mean they share a single `opened` flag (opening one
    // would close the other); two menus and three calls means a dead one.
    const hookCalls = chrome.match(/useIframeAwareMenu\(/g) ?? [];
    expect(
      hookCalls,
      'the number of `useIframeAwareMenu()` calls must equal the number of `<Menu>`s in the ' +
        'chrome — each menu owns its own open state.'
    ).toHaveLength(tags.length);
  });

  it('the ⋮ overflow trigger is addressable by a stable testid, like its siblings', () => {
    const chrome = chromeSource();
    // Reachable only by accessible name, the ⋮ trigger broke every test that
    // touched it whenever the copy changed. Its siblings all carry a testid.
    expect(chrome).toContain('data-testid="app-block-menu-trigger"');
    // Named alongside the sibling ledger so a rename of the family is visible
    // here rather than only in a browser suite that does not gate a merge.
    for (const id of [
      'app-block-chrome',
      'app-platform-nav-trigger',
      'app-block-name',
      'app-block-menu-trigger',
    ]) {
      expect(chrome, `chrome testid \`${id}\` is missing`).toContain(`data-testid="${id}"`);
    }
  });
});
