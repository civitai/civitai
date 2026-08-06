import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * 🔴 SUFFICIENCY GUARD for the `civitai generate` OAuth scope grant (issue #3681).
 *
 * The fix for #3681 widens the `civitai-cli` OAuth client's `allowedScopes` to
 * `UserRead | AIServicesRead | AIServicesWrite | BuzzRead | AppBlocksSubmit |
 * AppBlocksDevTunnel` = 100777985 (see
 * `packages/civitai-db-schema/prisma/migrations/20260806140000_widen_civitai_cli_oauth_client_ai_services_scopes/migration.sql`).
 * That is a claim about a SET of procedures: every tRPC call the `generate`
 * command makes must be satisfiable by that mask. This test IS that claim.
 *
 * WHY A SOURCE-LEVEL GUARD. The regression it defends against is not "someone
 * changes the scope constant" — it is a procedure on the generate path acquiring
 * a REQUIREMENT the CLI token cannot meet, most cheaply by LOSING its
 * `.meta({ requiredScope })` line. `enforceTokenScope` treats an un-annotated
 * procedure as implicitly requiring `TokenScope.Full`
 * (`src/server/services/oauth/enforce-token-scope.ts`), so deleting a `.meta`
 * line — the sort of thing that happens in a refactor with no visible symptom —
 * silently 403s every scoped token, and no behavioural test of that procedure
 * (which is normally exercised with a session or a Full key) would notice.
 * Reading the requirement off the SOURCE is the only way to see the ABSENCE of
 * an annotation; a runtime assertion on a mocked caller cannot distinguish
 * "annotated with Full" from "not annotated".
 *
 * MECHANISM: the TypeScript AST, not a regex — the `.meta(...)` call is located
 * on the LEFT SPINE of each procedure's builder chain (so a `.meta` appearing
 * inside a resolver body or an argument cannot be mistaken for the procedure's
 * own), and `requiredScope` is resolved by enum key against `TokenScope`.
 *
 * 🔴 SCOPE OF THIS TEST — what it does NOT prove. It pins the scope REQUIREMENTS
 * of a named set of procedures. It does not prove that set is what the CLI
 * actually calls (that lives in the `civitai/cli` repo and cannot be read from
 * here), nor that the client row in any database really holds 100777985 (the
 * migration is manual-apply). If the CLI grows a seventh call, adding it here is
 * a manual step.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * The tRPC procedures the `civitai generate` command exercises, by router file
 * and the exported router const inside it.
 *
 * - `whatIfFromGraph`      — pre-submit cost estimate
 * - `generateFromGraph`    — the submit itself
 * - `getWorkflow`          — poll a submitted workflow
 * - `queryGeneratedImages` — collect the results
 * - `cancelWorkflow`       — Ctrl-C / `--cancel`
 * - `buzz.getBuzzAccount`  — the pre-flight insufficient-balance guard. This one
 *   FAILS SOFT in the CLI (it warns and continues), so its bit is a UX
 *   requirement rather than a functional one — but it is in the grant, so it is
 *   in this population.
 */
const GENERATE_SURFACE: { file: string; routerConst: string; procedures: string[] }[] = [
  {
    file: 'src/server/routers/orchestrator.router.ts',
    routerConst: 'orchestratorRouter',
    procedures: [
      'whatIfFromGraph',
      'generateFromGraph',
      'getWorkflow',
      'queryGeneratedImages',
      'cancelWorkflow',
    ],
  },
  {
    file: 'src/server/routers/buzz.router.ts',
    routerConst: 'buzzRouter',
    procedures: ['getBuzzAccount'],
  },
];

const TOTAL_PROCEDURES = GENERATE_SURFACE.reduce((n, g) => n + g.procedures.length, 0);

/**
 * The mask the widened `civitai-cli` client grants. Pinned as a literal against
 * the migration (which is the source of truth for the DB value) and cross-checked
 * against the enum below.
 */
const CLI_GRANT = 100777985;

interface ProcedureScope {
  key: string;
  /** Resolved `requiredScope`, or `null` when the procedure carries no `.meta({ requiredScope })`. */
  requiredScope: number | null;
  /** Enum key as written in source, e.g. `AIServicesWrite`. `null` when absent. */
  scopeKey: string | null;
  blockApiKeys: boolean;
}

function parse(file: string): ts.SourceFile {
  const full = path.join(REPO_ROOT, file);
  return ts.createSourceFile(
    file,
    fs.readFileSync(full, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );
}

/** The object literal passed to `router({ ... })` for `export const <name> = router({...})`. */
function routerObject(sf: ts.SourceFile, routerConst: string): ts.ObjectLiteralExpression {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === routerConst &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'router' &&
      node.initializer.arguments[0] &&
      ts.isObjectLiteralExpression(node.initializer.arguments[0])
    ) {
      found = node.initializer.arguments[0] as ts.ObjectLiteralExpression;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`could not locate \`const ${routerConst} = router({...})\``);
  return found;
}

/**
 * Every `.meta(...)` object literal on the LEFT SPINE of a builder chain.
 * `a.meta(X).input(Y).query(Z)` → walks query → input → meta, never descending
 * into `X`/`Y`/`Z`, so a `.meta` inside a resolver body is out of reach.
 */
function metaObjectsOnSpine(expr: ts.Expression): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  let cur: ts.Node = expr;
  while (ts.isCallExpression(cur)) {
    const callee = cur.expression;
    if (!ts.isPropertyAccessExpression(callee)) break;
    if (callee.name.text === 'meta') {
      const arg = cur.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) out.push(arg);
    }
    cur = callee.expression;
  }
  return out;
}

/** `requiredScope: TokenScope.Foo` → `'Foo'`; anything else → undefined. */
function readScopeKey(meta: ts.ObjectLiteralExpression): string | undefined {
  for (const prop of meta.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name) ? prop.name.text : undefined;
    if (name !== 'requiredScope') continue;
    const init = prop.initializer;
    if (
      ts.isPropertyAccessExpression(init) &&
      ts.isIdentifier(init.expression) &&
      init.expression.text === 'TokenScope'
    ) {
      return init.name.text;
    }
    throw new Error(
      `requiredScope is not a plain \`TokenScope.<Key>\` reference — this guard cannot resolve it`
    );
  }
  return undefined;
}

function readBlockApiKeys(meta: ts.ObjectLiteralExpression): boolean {
  for (const prop of meta.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name) ? prop.name.text : undefined;
    if (name === 'blockApiKeys' && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
  }
  return false;
}

function collect(): ProcedureScope[] {
  const out: ProcedureScope[] = [];
  for (const group of GENERATE_SURFACE) {
    const obj = routerObject(parse(group.file), group.routerConst);
    for (const name of group.procedures) {
      const prop = obj.properties.find(
        (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name
      );
      if (!prop || !ts.isPropertyAssignment(prop)) {
        throw new Error(
          `procedure \`${name}\` not found as a direct property of \`${group.routerConst}\` in ${group.file} — ` +
            `it was renamed, moved, or deleted. Update GENERATE_SURFACE deliberately.`
        );
      }
      const metas = metaObjectsOnSpine(prop.initializer);
      const scopeKey = metas.map(readScopeKey).find((k) => k !== undefined) ?? null;
      const scopes = TokenScope as unknown as Record<string, number>;
      if (scopeKey !== null && typeof scopes[scopeKey] !== 'number') {
        throw new Error(`\`TokenScope.${scopeKey}\` (on ${name}) is not a member of the enum`);
      }
      out.push({
        key: `${group.routerConst}.${name}`,
        requiredScope: scopeKey === null ? null : scopes[scopeKey],
        scopeKey,
        blockApiKeys: metas.some(readBlockApiKeys),
      });
    }
  }
  return out;
}

describe('civitai generate — OAuth scope surface', () => {
  it('the AST walk finds every procedure on the generate path', () => {
    const found = collect();
    // Positive control: a zero/short result here would make every assertion below
    // pass vacuously (a union over an empty set is 0, which is trivially covered).
    expect(found).toHaveLength(TOTAL_PROCEDURES);
    expect(found.map((p) => p.key).sort()).toEqual(
      [
        'buzzRouter.getBuzzAccount',
        'orchestratorRouter.cancelWorkflow',
        'orchestratorRouter.generateFromGraph',
        'orchestratorRouter.getWorkflow',
        'orchestratorRouter.queryGeneratedImages',
        'orchestratorRouter.whatIfFromGraph',
      ].sort()
    );
  });

  it('every procedure on the generate path declares an explicit requiredScope', () => {
    for (const p of collect()) {
      expect(
        p.requiredScope,
        `${p.key} has no \`.meta({ requiredScope })\`. enforceTokenScope then treats it as ` +
          `implicitly requiring TokenScope.Full, which the scoped \`civitai login\` token can ` +
          `never satisfy — every \`civitai generate\` run 403s on this call.`
      ).not.toBeNull();
    }
  });

  it('no procedure on the generate path is blockApiKeys', () => {
    for (const p of collect()) {
      expect(
        p.blockApiKeys,
        `${p.key} is marked blockApiKeys, which forbids ANY token — scope cannot fix it.`
      ).toBe(false);
    }
  });

  it('the union of required scopes is exactly AIServicesRead|AIServicesWrite|BuzzRead', () => {
    const found = collect();
    const union = found.reduce((acc, p) => acc | (p.requiredScope ?? TokenScope.Full), 0);
    expect(union).toBe(
      TokenScope.AIServicesRead | TokenScope.AIServicesWrite | TokenScope.BuzzRead
    );
    expect(union).toBe(114688);
  });

  it('the widened civitai-cli grant COVERS that union', () => {
    const found = collect();
    const union = found.reduce((acc, p) => acc | (p.requiredScope ?? TokenScope.Full), 0);
    const uncovered = union & ~CLI_GRANT;
    expect(
      uncovered,
      `the generate path requires scope bits ${uncovered} that the civitai-cli client ` +
        `(allowedScopes=${CLI_GRANT}) does not grant — \`civitai generate\` would 403.`
    ).toBe(0);

    // The grant literal must agree with the enum, or the check above is about the
    // wrong number.
    expect(
      TokenScope.UserRead |
        TokenScope.AIServicesRead |
        TokenScope.AIServicesWrite |
        TokenScope.BuzzRead |
        TokenScope.AppBlocksSubmit |
        TokenScope.AppBlocksDevTunnel
    ).toBe(CLI_GRANT);

    // Negative control for the coverage assertion: the PRE-fix grant (without bits
    // 14/15/16) must NOT cover the union. Without this, `uncovered === 0` would be
    // consistent with a union of 0 or a grant of ~0.
    const PRE_FIX_GRANT = 100663297;
    expect(union & ~PRE_FIX_GRANT).not.toBe(0);
  });

  it('pins each procedure’s individual requiredScope', () => {
    const byKey = Object.fromEntries(collect().map((p) => [p.key, p.scopeKey]));
    expect(byKey).toEqual({
      'orchestratorRouter.whatIfFromGraph': 'AIServicesRead',
      'orchestratorRouter.generateFromGraph': 'AIServicesWrite',
      'orchestratorRouter.getWorkflow': 'AIServicesRead',
      'orchestratorRouter.queryGeneratedImages': 'AIServicesRead',
      'orchestratorRouter.cancelWorkflow': 'AIServicesWrite',
      'buzzRouter.getBuzzAccount': 'BuzzRead',
    });
  });
});
