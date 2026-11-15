import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every App Block generation kind audits its prompt through `auditAppBlockPrompt` (directly or
 * via the pass-through audits), BEFORE it quotes or reserves anything, and the one submit
 * procedure turns that refusal into a coded snapshot. A source-order guard: a new kind, or an
 * audit moved after the money, fails here rather than in production.
 */

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const router = read('../../routers/blocks.router.ts');
const stepModeration = read('../blocks/steps/moderation.ts');

/** A top-level function's source: from its declaration to the next top-level declaration. */
function body(source: string, name: string): string {
  const start = source.indexOf(`\nasync function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:async function |function |export |const |type )/);
  return end === -1 ? rest : rest.slice(0, end);
}

function submitWorkflowBody(): string {
  const start = router.indexOf('  submitWorkflow: publicProcedure');
  const end = router.indexOf('\n  getMyBuzzBalance: ', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return router.slice(start, end);
}

const MONEY = /quotePassThroughBuzz\(|reserveBlockBuzzSpendForClaims\(|claimGenIdempotency\(/;

function expectAuditBeforeMoney(source: string, audit: RegExp, label: string) {
  const auditAt = source.search(audit);
  expect(auditAt, `${label}: no audit call`).toBeGreaterThan(-1);
  const moneyAt = source.search(MONEY);
  // A kind whose money step is renamed or moved out of view must fail here, not pass.
  expect(moneyAt, `${label}: no quote, reservation or claim found`).toBeGreaterThan(-1);
  expect(auditAt, `${label}: audit after money`).toBeLessThan(moneyAt);
}

describe('App Block prompt refusal coverage', () => {
  it.each([
    ['submitPassThroughStepWorkflow', /await auditPassThroughPrompts\(/],
    ['submitMultiStepWorkflow', /await auditPassThroughPrompts\(/],
    ['submitConfirmedPassThroughStepWorkflow', /await auditPassThroughPrompts\(/],
    ['submitCustomComfyWorkflow', /await auditAppBlockPrompt\(/],
    ['submitStepWorkflow', /await runStepModeration\(/],
  ])('%s audits before it quotes or reserves', (name, audit) => {
    expectAuditBeforeMoney(body(router, name), audit, name);
  });

  it('training audits in its preflight, which runs before the shared submit claims or reserves', () => {
    expect(body(router, 'submitTrainingWorkflow')).toMatch(
      /preflight: async[\s\S]*?await auditTrainingSamplePrompts\(/
    );
    expectAuditBeforeMoney(
      body(router, 'submitConfirmedQuoteWorkflow'),
      /await arm\.preflight\?\.\(/,
      'submitConfirmedQuoteWorkflow'
    );
  });

  it('textToImage, inline in the procedure, audits before it reserves', () => {
    expectAuditBeforeMoney(submitWorkflowBody(), /await auditAppBlockPrompt\(/, 'textToImage');
  });

  it('the registry step audit goes through the App Block wrapper', () => {
    expect(stepModeration).toMatch(/await auditAppBlockPrompt\(/);
  });

  it('no App Block site calls the gate around the wrapper', () => {
    expect(router).not.toMatch(/await auditPromptServer\(/);
    expect(stepModeration).not.toMatch(/await auditPromptServer\(/);
  });

  it('the submit procedure answers a refusal as a coded snapshot', () => {
    expect(submitWorkflowBody()).toMatch(/\.use\(promptRefusalAsSnapshot\)/);
  });
});
