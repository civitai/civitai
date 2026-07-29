import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  ParentBasedSampler,
} from '@opentelemetry/sdk-trace-web';
import { describe, expect, it } from 'vitest';
import {
  createTraceSampler,
  parseRate,
  resolveFaroSampling,
} from '~/utils/faro/traceSampler';

describe('parseRate', () => {
  it('parses a valid float', () => {
    expect(parseRate('0.1', 0.5)).toBe(0.1);
    expect(parseRate('0.42', 0.5)).toBe(0.42);
  });

  it('clamps into [0, 1]', () => {
    expect(parseRate('2', 0.5)).toBe(1);
    expect(parseRate('-1', 0.5)).toBe(0);
  });

  it('falls back on unset / non-numeric input', () => {
    expect(parseRate(undefined, 0.1)).toBe(0.1);
    expect(parseRate('', 0.1)).toBe(0.1);
    expect(parseRate('not-a-number', 0.1)).toBe(0.1);
  });

  it('accepts the boundary values 0 and 1', () => {
    expect(parseRate('0', 0.1)).toBe(0);
    expect(parseRate('1', 0.1)).toBe(1);
    expect(parseRate('1.0', 0.1)).toBe(1);
  });
});

describe('createTraceSampler', () => {
  it('builds a genuine ParentBased(TraceIdRatioBased) sampler at the configured ratio', () => {
    const sampler = createTraceSampler(0.1);
    // Genuine OTel ParentBasedSampler wrapping a TraceIdRatioBasedSampler at 0.1 — NOT
    // Faro's session-coupled decision, and NOT always-on/always-off.
    expect(sampler).toBeInstanceOf(ParentBasedSampler);
    expect(sampler).not.toBeInstanceOf(AlwaysOnSampler);
    expect(sampler).not.toBeInstanceOf(AlwaysOffSampler);
    // OTel sampler descriptions are stable and encode the ratio.
    expect(sampler.toString()).toContain('ParentBased');
    expect(sampler.toString()).toContain('TraceIdRatioBased{0.1}');
  });

  it('encodes the exact ratio it was given', () => {
    expect(createTraceSampler(0.25).toString()).toContain('TraceIdRatioBased{0.25}');
    expect(createTraceSampler(0.5).toString()).toContain('TraceIdRatioBased{0.5}');
  });

  it('rate >= 1 → AlwaysOnSampler (effectively no sampling)', () => {
    expect(createTraceSampler(1)).toBeInstanceOf(AlwaysOnSampler);
    expect(createTraceSampler(1.5)).toBeInstanceOf(AlwaysOnSampler);
  });

  it('rate <= 0 → AlwaysOffSampler (no traces; errors/vitals unaffected)', () => {
    expect(createTraceSampler(0)).toBeInstanceOf(AlwaysOffSampler);
    expect(createTraceSampler(-1)).toBeInstanceOf(AlwaysOffSampler);
  });

  it('defends against a non-finite rate by falling back to the 0.1 default', () => {
    expect(createTraceSampler(Number.NaN).toString()).toContain('TraceIdRatioBased{0.1}');
  });
});

describe('resolveFaroSampling — the session/trace decoupling', () => {
  it('reads session rate from the SESSION env and the trace sampler from the TRACES env', () => {
    const { sessionSamplingRate, traceSampler } = resolveFaroSampling('1.0', '0.1');
    expect(sessionSamplingRate).toBe(1.0);
    expect(traceSampler.toString()).toContain('TraceIdRatioBased{0.1}');
  });

  it('trace sampling of 0 does NOT gate session sampling (errors/web-vitals stay 100%)', () => {
    // The crux: setting traces to 0 zeroes the trace sampler but leaves session sampling at
    // its own (SESSION-env) value of 1.0 — so errors/web-vitals/events remain 100%.
    const { sessionSamplingRate, traceSampler } = resolveFaroSampling('1.0', '0');
    expect(sessionSamplingRate).toBe(1.0);
    expect(traceSampler).toBeInstanceOf(AlwaysOffSampler);
  });

  it('setting traces to 0.1 does NOT set session sampling to 0.1', () => {
    const { sessionSamplingRate } = resolveFaroSampling('1.0', '0.1');
    expect(sessionSamplingRate).not.toBe(0.1);
    expect(sessionSamplingRate).toBe(1.0);
  });

  it('session sampling is invariant across every trace-rate value', () => {
    for (const traceRate of ['0', '0.1', '0.5', '1']) {
      expect(resolveFaroSampling('1.0', traceRate).sessionSamplingRate).toBe(1.0);
    }
  });

  it('the two layers use independent defaults (session 1.0, traces 0.1)', () => {
    const { sessionSamplingRate, traceSampler } = resolveFaroSampling(undefined, undefined);
    expect(sessionSamplingRate).toBe(1.0);
    expect(traceSampler.toString()).toContain('TraceIdRatioBased{0.1}');
  });
});
