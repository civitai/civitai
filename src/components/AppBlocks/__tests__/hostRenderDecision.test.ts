import { describe, expect, it } from 'vitest';

import { hostRenderDecision } from '../hostRenderDecision';
import type { HostStatus } from '../hostRenderDecision';

const SRC = 'https://generate-from-model.civit.ai/';
const ORIGIN = 'https://generate-from-model.civit.ai';

describe('hostRenderDecision', () => {
  describe('terminal-failure states collapse (render nothing)', () => {
    const terminalStatuses: HostStatus[] = ['timeout', 'fatal', 'no_token'];

    it.each(terminalStatuses)('collapses on status "%s"', (status) => {
      expect(hostRenderDecision({ iframeSrc: SRC, expectedOrigin: ORIGIN, status })).toBe(
        'collapse'
      );
    });

    it('collapses on a malformed manifest (empty iframe.src)', () => {
      expect(
        hostRenderDecision({ iframeSrc: '', expectedOrigin: ORIGIN, status: 'loading' })
      ).toBe('collapse');
    });

    it('collapses on a malformed manifest (unparseable origin)', () => {
      expect(
        hostRenderDecision({ iframeSrc: SRC, expectedOrigin: '', status: 'loading' })
      ).toBe('collapse');
    });

    it('collapses on a bad-src manifest even when status would otherwise be ready', () => {
      expect(
        hostRenderDecision({ iframeSrc: '', expectedOrigin: '', status: 'ready' })
      ).toBe('collapse');
    });
  });

  describe('non-failure states render content', () => {
    it('keeps the loading skeleton during "loading"', () => {
      expect(
        hostRenderDecision({ iframeSrc: SRC, expectedOrigin: ORIGIN, status: 'loading' })
      ).toBe('loading');
    });

    it('renders the framed block on "ready"', () => {
      expect(
        hostRenderDecision({ iframeSrc: SRC, expectedOrigin: ORIGIN, status: 'ready' })
      ).toBe('ready');
    });
  });

  describe('invariant: ready is the ONLY state that renders the trust chrome', () => {
    it('every terminal-failure state collapses (no chrome, container takes no space)', () => {
      const allStatuses: HostStatus[] = ['loading', 'ready', 'timeout', 'fatal', 'no_token'];
      const collapsing = allStatuses.filter(
        (status) =>
          hostRenderDecision({ iframeSrc: SRC, expectedOrigin: ORIGIN, status }) === 'collapse'
      );
      expect(collapsing.sort()).toEqual(['fatal', 'no_token', 'timeout']);
    });
  });
});
