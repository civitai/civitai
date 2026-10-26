import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The seam between `_app` and FaroProvider's RUM page attributes (`src/utils/faro/pageAttributes.ts`).
 * FaroProvider's `shell` / `signedIn` props are required, so dropping one fails tsc; what tsc cannot
 * see is a SWAP (`shell={bootedSignedIn}`) or a value read from the wrong place. So this pins the
 * literal text of both prop initializers and of the two `useState` initializers that freeze them
 * from the hard load's pageProps.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const APP_FILE = 'src/pages/_app.tsx';

function parse(relPath: string): ts.SourceFile {
  const abs = path.join(REPO_ROOT, relPath);
  return ts.createSourceFile(
    abs,
    fs.readFileSync(abs, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function collect(node: ts.Node, predicate: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node) => {
    if (predicate(n)) out.push(n);
    n.forEachChild(walk);
  };
  walk(node);
  return out;
}

function myAppBody(): ts.Block {
  const decl = collect(
    parse(APP_FILE),
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'MyApp'
  )[0] as ts.FunctionDeclaration | undefined;
  if (!decl?.body) {
    throw new Error(
      `${APP_FILE}: no \`function MyApp\` with a body found. Re-point this guard at the component ` +
        `that renders <FaroProvider> rather than deleting it.`
    );
  }
  return decl.body;
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('_app → FaroProvider page attributes', () => {
  it('passes the frozen hard-load values to the matching props', () => {
    const faro = collect(
      myAppBody(),
      (n) =>
        (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
        ts.isIdentifier(n.tagName) &&
        n.tagName.text === 'FaroProvider'
    ) as (ts.JsxSelfClosingElement | ts.JsxOpeningElement)[];
    if (faro.length !== 1) throw new Error(`expected one <FaroProvider>, found ${faro.length}`);

    const initializers = Object.fromEntries(
      faro[0].attributes.properties
        .filter((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ts.isIdentifier(p.name))
        .filter((p) => ['shell', 'signedIn'].includes((p.name as ts.Identifier).text))
        .map((p) => [(p.name as ts.Identifier).text, p.initializer?.getText()])
    );
    expect(initializers).toEqual({ shell: '{bootedShell}', signedIn: '{bootedSignedIn}' });
  });

  it('freezes them from the hard load’s pageProps at the first render', () => {
    const frozen = Object.fromEntries(
      (
        collect(
          myAppBody(),
          (n) =>
            ts.isVariableDeclaration(n) &&
            ts.isArrayBindingPattern(n.name) &&
            !!n.initializer &&
            ts.isCallExpression(n.initializer) &&
            n.initializer.expression.getText() === 'useState'
        ) as ts.VariableDeclaration[]
      )
        .map((d) => [
          squash((d.name as ts.ArrayBindingPattern).elements[0].getText()),
          squash((d.initializer as ts.CallExpression).arguments[0].getText()),
        ])
        .filter(([name]) => name === 'bootedShell' || name === 'bootedSignedIn')
    );
    expect(frozen).toEqual({
      bootedShell: '() => shell === true',
      bootedSignedIn: '() => isHardLoadSignedIn({ session, hasAuthCookie: pageHasAuthCookie })',
    });
  });
});
