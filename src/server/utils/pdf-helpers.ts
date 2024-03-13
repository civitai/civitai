import * as puppeteer from 'puppeteer';

export const htmlToPdf = async (html: string, options: puppeteer.PDFOptions = {}) => {
  // Create a browser instance
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  // Create a new page
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  // To reflect CSS used for screens instead of print
  await page.emulateMediaType('screen');
  // Download the PDF
  const PDF = await page.pdf({
    printBackground: true,
    margin: { top: '100px', right: '50px', bottom: '100px', left: '50px' },
    format: 'A4',
    ...options,
  });
  // Close the browser instance
  await browser.close();
  return PDF;
};
