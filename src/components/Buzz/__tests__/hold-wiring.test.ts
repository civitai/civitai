import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../test/strip-comments';

// Pins the decision made in civitai/civitai#10103.
// The request popup must never place its hold on the back of a Buzz purchase. The rule lives in
// onPurchaseSuccessAction and serviceHoldButtonProps (each tested on its values); these pin that
// the two call sites use them. Rendering the real path needs a tRPC wire harness the repo does not
// have, so the wiring is read from source. Each anchor is a whole element or call that must be
// unique, so an insertion beside the wiring cannot satisfy it.

const read = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), 'utf8'));
// Formatting-proof: compare with all whitespace removed.
const squash = (s: string) => s.replace(/\s+/g, '');

describe('hold wiring', () => {
  it("the modal's hold button takes its props from serviceHoldButtonProps", () => {
    const source = read('src/components/CreatorShop/Services/deals/ServiceRequestModal.tsx');
    const buttons = source.match(/<BuzzTransactionButton\b[\s\S]*?\/>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(source.match(/serviceHoldButtonProps\(/g) ?? []).toHaveLength(1);
    const [button = ''] = buttons;
    expect(squash(button)).toContain('{...serviceHoldButtonProps(terms.price)}');
  });

  it('no attribute on that button sets what the spread supplies, before or after it', () => {
    const source = read('src/components/CreatorShop/Services/deals/ServiceRequestModal.tsx');
    const buttons = source.match(/<BuzzTransactionButton\b[\s\S]*?\/>/g) ?? [];
    expect(buttons).toHaveLength(1);
    const [element = ''] = buttons;
    const button = squash(element);
    expect(button).not.toContain('performTransactionOnPurchase=');
    expect(button).not.toContain('label=');
    expect(button).not.toContain('aria-label=');
  });

  it('the short-buyer purchase runs the action only through onPurchaseSuccessAction', () => {
    const source = read('src/components/Buzz/buzz.utils.ts');
    const calls = source.match(/onBuyBuzz\(\{[\s\S]*?\}\);/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(source.match(/onPurchaseSuccess:/g) ?? []).toHaveLength(1);
    const [call = ''] = calls;
    expect(squash(call)).toContain(
      'onPurchaseSuccess:onPurchaseSuccessAction(performTransactionOnPurchase,onPerformTransaction),'
    );
  });
});
