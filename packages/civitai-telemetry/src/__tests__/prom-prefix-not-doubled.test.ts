import { describe, expect, it } from 'vitest';
import promClient from 'prom-client';
import { PROM_PREFIX } from '../client';

// The name-taking helpers in ../client (registerCounter / registerCounterWithLabels /
// registerGauge / registerGaugeWithLabels / registerHistogram) prepend PROM_PREFIX, so the
// `name:` a caller passes must NOT already carry it. Spelling it twice is silent:
// registration succeeds, /metrics scrapes fine, and the series is published under a name
// nobody queries. `clickhouseFailSoftCounter` shipped that way and emitted
// `civitai_app_civitai_app_clickhouse_failsoft_total`.
//
// Asserted against the registry, not the source literal, so a name that only looks right
// cannot pass. Importing ../client is what performs the registrations.
describe('PROM_PREFIX is applied exactly once', () => {
  it('registers no metric whose name carries the prefix twice', () => {
    const names = promClient.register.getMetricsAsArray().map((m) => (m as { name: string }).name);

    // Positive control: the import really did register this file's metrics, so a clean
    // result below means "no doubled names", not "no names at all".
    expect(names.filter((n) => n.startsWith(PROM_PREFIX)).length).toBeGreaterThan(10);

    expect(names.filter((n) => n.startsWith(PROM_PREFIX + PROM_PREFIX))).toEqual([]);
  });
});
