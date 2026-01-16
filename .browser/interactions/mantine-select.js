/**
 * Mantine Select Helper
 *
 * Use when: Interacting with Mantine Select, Combobox, or MultiSelect components
 * Identify by: Input with role="combobox" or Mantine classes like mantine-Select-input
 *
 * @param {Page} page - Playwright page
 * @param {string} label - The label text of the select field
 * @param {string} value - The option text to select
 */
module.exports = async function mantineSelect(page, label, value) {
  // Find and click the select input by label
  const input = page.getByLabel(label);
  await input.click();

  // Wait for dropdown to appear (Mantine uses portals)
  await page.waitForSelector('[role="listbox"], [data-combobox-popover]', { timeout: 5000 });

  // Click the option
  const option = page.locator(`[role="option"]:has-text("${value}"), [data-combobox-option]:has-text("${value}")`).first();
  await option.click();

  // Wait for dropdown to close
  await page.waitForTimeout(200);
};
