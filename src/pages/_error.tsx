import type { NextPageContext } from 'next';
import NextErrorComponent from 'next/error';
import React from 'react';
import { reportBoundaryError } from '~/components/ErrorBoundary/reportBoundaryError';

type Props = { statusCode: number };

/**
 * Reports client-side errors that no app-owned boundary can catch.
 *
 * 🔴 Why this file and not a boundary in `_app`: a React error boundary cannot catch a throw from
 * its own PARENT's render, so a throw in `_app`'s render body reaches none of the app's own
 * boundaries — every one of them lives inside the JSX `_app` returns. Next already catches it, in
 * a boundary structurally above the default export (`Container` in `next/dist/client/index.js`),
 * and then renders THIS page. What it does NOT do is report: it calls `console.error` and nothing
 * else, and a boundary-caught error never reaches `window.onerror`, which is what Faro's error
 * instrumentation hooks. So the gap was never "nothing catches it" — it was "nothing reports it",
 * and `getInitialProps({ err })` is the documented hook Next hands us for exactly that.
 *
 * That shipped for real: #4867 threw on every client-side navigation and users saw
 * *"Application error: a client-side exception has occurred"* — this page's predecessor, Next's
 * built-in — while Faro logged zero beacons for it.
 *
 * ⚠ Scope, stated because it is easy to overclaim: the report below is **client-side only**.
 * `fetch('/api/application-error')` needs a relative URL to resolve against a document, so a
 * server-rendered error cannot use it — those already reach the server logs by other means, which
 * is why the incident this addresses was client-only in the first place.
 *
 * ⚠ `404`s do not come here: `src/pages/404.tsx` takes them.
 */
function CustomErrorPage({ statusCode }: Props) {
  return <NextErrorComponent statusCode={statusCode} />;
}

CustomErrorPage.getInitialProps = async (ctx: NextPageContext): Promise<Props> => {
  const { err, res } = ctx;
  const statusCode = res?.statusCode ?? err?.statusCode ?? 500;

  // `typeof window` is the guard, not `!res`: Next calls this on the client for the
  // caught-render-error path with no `res` AND on the server for an SSR failure, and only the
  // former can reach a relative URL.
  if (err && typeof window !== 'undefined') {
    reportBoundaryError(err, { boundary: 'root' });
  }

  return { statusCode };
};

export default CustomErrorPage;
