import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { VerifiedText } from '~/components/VerifiedText/VerifiedText';
import { ScanResultCode } from '~/shared/utils/prisma/enums';

// The file-scan mark is a radar, not a shield: the shield is the SFW-only mark beside it on the
// model page, and two shields side by side read as one claim. Error is gray like Pending, not
// orange: both mean "not scanned" (decided 2026-10-23).
const file = (result: ScanResultCode) => ({
  virusScanResult: result,
  virusScanMessage: null,
  pickleScanResult: result,
  pickleScanMessage: null,
  scannedAt: new Date('2026-10-01'),
});

const icons = () =>
  Array.from(document.querySelectorAll('svg.tabler-icon')).map((svg) => ({
    icon: Array.from(svg.classList).find((c) => c.startsWith('tabler-icon-')),
    color: (svg.parentElement as HTMLElement).style.color,
  }));

describe('VerifiedText icon', () => {
  test.each([
    [ScanResultCode.Success, 'Verified:', 'tabler-icon-radar-2', 'green'],
    [ScanResultCode.Danger, 'Unverified:', 'tabler-icon-alert-triangle', 'red'],
    [ScanResultCode.Pending, 'Unverified:', 'tabler-icon-radar-off', 'gray'],
    [ScanResultCode.Error, 'Unverified:', 'tabler-icon-radar-off', 'gray'],
  ])('%s shows %s with %s in %s', async (result, text, icon, color) => {
    renderWithProviders(<VerifiedText file={file(result)} />);
    await expect.element(page.getByText(text)).toBeInTheDocument();
    expect(icons()).toEqual([{ icon, color: `var(--mantine-color-${color}-6)` }]);
  });
});
