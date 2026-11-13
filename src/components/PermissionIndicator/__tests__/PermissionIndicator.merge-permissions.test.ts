import { describe, expect, it, vi } from 'vitest';
import type { PermissionIndicatorBaseProps } from '~/components/PermissionIndicator/PermissionIndicatorBase';
import { CommercialUse } from '~/shared/utils/prisma/enums';

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const { PermissionIndicator } = await import(
  '~/components/PermissionIndicator/PermissionIndicator'
);

// PermissionIndicator calls no React hook of its own (useCurrentUser is mocked), so calling it
// returns the PermissionIndicatorBase element and its props are exactly what the strip renders.
const render = (allowDerivatives: boolean, allowDifferentLicense: boolean) =>
  PermissionIndicator({
    permissions: {
      allowNoCredit: true,
      allowCommercialUse: [CommercialUse.Image],
      allowDerivatives,
      allowDifferentLicense,
      sfwOnly: false,
    },
  }).props as PermissionIndicatorBaseProps;

const DIFFERENT_ALLOWED = 'Different permissions allowed on merges';
const SAME_REQUIRED = 'Same permissions required on merges';
const EXPLANATION_KEY = 'Have different permissions when sharing merges';

const licenseBadge = (props: PermissionIndicatorBaseProps) => {
  const matches = props.badges.filter(
    (b) => b.label === DIFFERENT_ALLOWED || b.label === SAME_REQUIRED
  );
  expect(matches).toHaveLength(1);
  return matches[0];
};

describe('PermissionIndicator: different permissions on merges', () => {
  it('reads a stored "different permissions" as off while merges are off', () => {
    const props = render(false, true);
    expect(licenseBadge(props)).toMatchObject({ label: SAME_REQUIRED, allowed: false });
    expect(props.explanation[EXPLANATION_KEY]).toBe(false);
  });

  it('control: still shows it when merges are allowed', () => {
    const props = render(true, true);
    expect(licenseBadge(props)).toMatchObject({ label: DIFFERENT_ALLOWED, allowed: true });
    expect(props.explanation[EXPLANATION_KEY]).toBe(true);
  });

  it('leaves the merges badge itself driven by allowDerivatives', () => {
    const merges = (p: PermissionIndicatorBaseProps) =>
      p.badges.find((b) => b.label === 'Merges allowed' || b.label === 'No merges allowed');
    expect(merges(render(false, true))).toMatchObject({ allowed: false });
    expect(merges(render(true, false))).toMatchObject({ allowed: true });
  });
});
