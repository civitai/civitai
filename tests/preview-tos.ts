import type { Page } from '@playwright/test';

/** Shared by the preview specs that open the app review page. NOT a test file. */

const PREVIEW_URL = process.env.PREVIEW_URL ?? '';

/**
 * 🔴 WHY THE REVIEW-PAGE SPECS MARK THE TERMS OF SERVICE AS ACCEPTED. The smoke `mod` account is seeded
 * with onboarding complete but no `tos*AcceptedHash`, so once the ToS body changes from the
 * rollout baseline the site opens its forced, un-dismissable ToS re-acceptance modal on every
 * page (`useToSUpdateModal`: re-prompt iff the accepted hash differs from the served one). It
 * covered the review page and swallowed every click — measured on the PR preview: the
 * `section[role=dialog][aria-label="Terms of Service"]` overlay intercepted the Code-tab click,
 * and neither its close affordance nor Escape closes it.
 *
 * So a spec records acceptance the way the modal's own Accept does — `user.setSettings`
 * with the domain's date field and accepted-hash field — using the metadata the page itself
 * was served (`tosMeta`: which fields this domain reads, and the hash to store). Nothing is
 * clicked through, and nothing is dismissed: any OTHER dialog on the review page is a failure
 * (`expectNoOpenDialog`).
 */
export async function acceptTermsForThisDomain(page: Page) {
  const meta = await page.evaluate(() => {
    const d = (window as unknown as { __NEXT_DATA__?: { props?: Record<string, unknown> } })
      .__NEXT_DATA__;
    const props = d?.props ?? {};
    const m = (props.tosMeta ??
      (props.pageProps as Record<string, unknown> | undefined)?.tosMeta) as
      | { hash?: string; fieldKey?: string; hashFieldKey?: string }
      | undefined;
    return m ?? null;
  });
  if (!meta?.hash || !meta.fieldKey || !meta.hashFieldKey) {
    throw new Error(`could not read the served ToS metadata: ${JSON.stringify(meta)}`);
  }
  // superjson body: the date field is a `z.date()`, so it needs the Date meta.
  const res = await page.request.post('/api/trpc/user.setSettings?batch=1', {
    headers: {
      'content-type': 'application/json',
      origin: PREVIEW_URL,
      referer: `${PREVIEW_URL}/`,
    },
    data: {
      '0': {
        json: { [meta.fieldKey]: new Date().toISOString(), [meta.hashFieldKey]: meta.hash },
        meta: { values: { [meta.fieldKey]: ['Date'] } },
      },
    },
  });
  if (!res.ok()) {
    throw new Error(`user.setSettings (ToS acceptance) -> HTTP ${res.status()}`);
  }
  console.log(
    `[preview-tos] ToS accepted for this domain via ${meta.fieldKey}/${meta.hashFieldKey}`
  );
}
