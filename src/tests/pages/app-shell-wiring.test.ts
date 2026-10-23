import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `_app`'s half of the shell boot: what `useShellBootstrap` returns must be what reaches each
 * provider. Its behaviour is pinned by `src/components/Shell/__tests__/shell-bootstrap.test.ts`,
 * which wires the same providers itself; this pins that `_app` wires them the same way, so a
 * provider reading the page's raw value instead (a viewer's cookie read during render, a session
 * fetch the seed was meant to replace) cannot pass both.
 */

const APP_FILE = path.resolve(__dirname, '../../pages/_app.tsx');
const app = ts.createSourceFile(
  APP_FILE,
  fs.readFileSync(APP_FILE, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

function collect<T extends ts.Node>(node: ts.Node, predicate: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const walk = (n: ts.Node) => {
    if (predicate(n)) out.push(n);
    n.forEachChild(walk);
  };
  walk(node);
  return out;
}

const myApp = collect(
  app,
  (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'MyApp'
);

function myAppBody() {
  expect(myApp, 'expected exactly one `function MyApp` in _app').toHaveLength(1);
  return myApp[0];
}

/** `{ name: initializer text }` for every attribute of the single `<tag>` in MyApp. */
function attributesOf(tag: string) {
  const openers = collect(
    myAppBody(),
    (n): n is ts.JsxOpeningElement | ts.JsxSelfClosingElement =>
      (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
      ts.isIdentifier(n.tagName) &&
      n.tagName.text === tag
  );
  expect(openers, `expected exactly one <${tag}> in MyApp`).toHaveLength(1);
  return Object.fromEntries(
    openers[0].attributes.properties.map((p) =>
      ts.isJsxAttribute(p)
        ? [p.name.getText(), p.initializer?.getText() ?? '(none)']
        : ['(spread)', p.getText()]
    )
  );
}

/** Every name a destructure in MyApp binds, nested ones included, with what it is bound from. */
function bindings() {
  const out: { name: string; from: string }[] = [];
  for (const el of collect(myAppBody(), ts.isBindingElement)) {
    if (!ts.isIdentifier(el.name)) continue;
    let decl: ts.Node | undefined = el;
    while (decl && !ts.isVariableDeclaration(decl)) decl = decl.parent;
    const init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
    out.push({
      name: el.name.text,
      from: init && ts.isCallExpression(init) ? init.expression.getText() : init?.getText() ?? '?',
    });
  }
  return out;
}

describe('_app hands the shell boot’s values to the providers', () => {
  it('binds the cookies, hasAuthCookie and adsGated it renders with from useShellBootstrap only', () => {
    const bound = bindings();
    for (const name of ['cookies', 'hasAuthCookie', 'adsGated'])
      expect(
        bound.filter((b) => b.name === name),
        `\`${name}\` must be bound once, from useShellBootstrap; the page's own value goes in`
      ).toEqual([{ name, from: 'useShellBootstrap' }]);
    for (const name of ['sessionSeed', 'flagsSeed', 'appShell', 'referralsPending', 'shellStatus'])
      expect(bound.filter((b) => b.name === name)).toEqual([{ name, from: 'useShellBootstrap' }]);
  });

  it('hands the page’s cookies to the boot as they came, without reading the jar itself', () => {
    const pageCookies = collect(
      myAppBody(),
      (n): n is ts.BindingElement =>
        ts.isBindingElement(n) && n.propertyName?.getText() === 'cookies'
    );
    expect(pageCookies.map((b) => [b.name.getText(), b.initializer?.getText() ?? null])).toEqual([
      ['pageCookies', null],
    ]);
  });

  it('keys the boot on a value fixed at mount', () => {
    const calls = collect(
      myAppBody(),
      (n): n is ts.CallExpression =>
        ts.isCallExpression(n) && n.expression.getText() === 'useShellBootstrap'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments[0].getText()).toBe('bootedShell');
    const booted = collect(
      myAppBody(),
      (n): n is ts.VariableDeclaration =>
        ts.isVariableDeclaration(n) && n.name.getText() === '[bootedShell]'
    );
    expect(booted.map((d) => d.initializer?.getText())).toEqual(['useState(() => shell === true)']);
  });

  it.each([
    ['AppProvider', 'shell', '{appShell}'],
    ['SessionProvider', 'seed', '{sessionSeed}'],
    ['FeatureFlagsProvider', 'seed', '{flagsSeed}'],
    ['ReferralsProvider', 'pending', '{referralsPending}'],
    ['ReferralsProvider', '(spread)', '{...cookies.referrals}'],
    ['AdsProvider', 'gated', '{adsGated}'],
    ['ThirdPartyConsentProvider', 'initialConsent', '{cookies.consent}'],
    ['CivitaiSessionProvider', 'disableHidden', '{cookies.disableHidden}'],
    ['ShellBootstrapProvider', 'status', '{shellStatus}'],
  ])('<%s %s=%s>', (tag, attribute, value) => {
    expect(attributesOf(tag)[attribute]).toBe(value);
  });
});
