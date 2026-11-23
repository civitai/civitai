// The shared transactional email layout. Layout only: branded copy stays in each app.

/**
 * Colour tokens for every email built on `renderEmailShell`, taken from the site theme (the main
 * app's `src/providers/ThemeProvider.tsx`): `band` is Mantine dark[7], the site's dark surface, and
 * `button`/`link` are blue[8]. blue[6] (#228BE6) is the site's usual primary but carries white text at
 * only about 3.6:1, so it is not used for the button. Surfaces are off-white rather than #fff so
 * clients that invert pure white in dark mode leave them alone. The main app's `email-theme.test.ts`
 * checks the WCAG contrast of each text/background pair.
 */
export const emailTheme = {
  band: '#1A1B1E',
  outer: '#f8f9fa',
  surface: '#fefefe',
  border: '#dee2e6',
  text: '#212529',
  muted: '#495057',
  footer: '#5C5F66',
  link: '#1971C2',
  button: '#1971C2',
  buttonText: '#ffffff',
  /** Alt text shown on the band when images are off. */
  logoAlt: '#ffffff',
  dark: {
    outer: '#101113',
    surface: '#25262B',
    border: '#373A40',
    text: '#C1C2C5',
    footer: '#A6A7AB',
    link: '#4DABF7',
  },
} as const;

export const emailFontStack =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';

/**
 * Served by the main app from `public/`. The white-text wordmark with the band colour baked in, so a
 * client that inverts colours still shows it on dark.
 */
export const emailLogoPath = '/images/email/logo-dark-band@2x.png';
export const EMAIL_LOGO_WIDTH = 142;
export const EMAIL_LOGO_HEIGHT = 30;

/** Class on the hidden preheader; the plain-text conversion skips it. */
export const EMAIL_PREHEADER_CLASS = 'em-preheader';
/**
 * Put this class on any element a caller styles with `emailTheme.muted`: an inline colour beats the
 * template's dark-mode rules, so without it the text would stay dark grey on the dark surface.
 */
export const EMAIL_MUTED_CLASS = 'em-muted';

// Font family attributes are double-quoted, so the stack's own quotes become single quotes.
const font = emailFontStack.replace(/"/g, "'");
const t = emailTheme;

// The only CSS that is not inline: clients that honour prefers-color-scheme (Apple Mail, iOS Mail)
// get a deliberate dark surface instead of an automatic inversion. Inline styles win over a
// stylesheet, so every rule needs !important.
const darkModeCss = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .em-body, .em-outer { background-color: ${t.dark.outer} !important; }
    .em-card { background-color: ${t.dark.surface} !important; border-color: ${t.dark.border} !important; }
    .em-text, .em-h1 { color: ${t.dark.text} !important; }
    .em-footer, .${EMAIL_MUTED_CLASS} { color: ${t.dark.footer} !important; border-color: ${t.dark.border} !important; }
    .em-card a:not(.em-btn) { color: ${t.dark.link} !important; }
  }
`;

// Classic Outlook ignores the system font names and padding on links: give it a font it has and
// put the button's padding on the cell.
const msoCss = `
  table, td, h1, p, a { font-family: Arial, Helvetica, sans-serif !important; }
  .em-btn-cell { mso-padding-alt: 12px 24px !important; }
`;

const stripTags = (html: string) =>
  html
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Where the logo is served from when a caller does not pass `baseUrl`: the main site, which hosts it. */
export const EMAIL_ASSET_ORIGIN = 'https://civitai.com';

export type EmailShellInput = {
  header: string;
  body: string;
  btnUrl?: string;
  btnLabel?: string;
  /** Content after the button, styled like the body. */
  afterButton?: string;
  /** Small print at the bottom of the card, below a divider. */
  footer?: string;
  preheader?: string;
  /** Origin the logo is loaded from (no trailing slash). Defaults to EMAIL_ASSET_ORIGIN. */
  baseUrl?: string;
};

/**
 * The shared transactional email layout: a full XHTML document with a dark brand band carrying the
 * logo, a heading, the body, an optional button, and optional text after the button and a footer.
 * The main app (`src/server/email/templates/util.ts`) and the spoke apps all render through this.
 *
 * Every value is inserted as HTML, so callers escape anything user-supplied. `preheader` is the
 * inbox preview line; it is hidden in the message and left out of the plain-text part.
 */
export const renderEmailShell = ({
  header,
  body,
  btnUrl,
  btnLabel,
  afterButton,
  footer,
  preheader,
  baseUrl = EMAIL_ASSET_ORIGIN,
}: EmailShellInput) => {
  const preheaderCode = !preheader
    ? ''
    : `<div class="${EMAIL_PREHEADER_CLASS}" style="display: none; max-height: 0; max-width: 0; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px; opacity: 0; color: ${t.outer};">${preheader}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>`;

  const buttonCode =
    !btnUrl || !btnLabel
      ? ''
      : `
            <tr>
              <td align="center" style="padding: 8px 32px 24px 32px;">
                <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                  <tr>
                    <td class="em-btn-cell" align="center" bgcolor="${t.button}" style="border-radius: 4px; background-color: ${t.button}; mso-padding-alt: 12px 24px;">
                      <a class="em-btn" href="${btnUrl}" target="_blank" style="display: inline-block; padding: 12px 24px; border: 1px solid ${t.button}; border-radius: 4px; background-color: ${t.button}; font-family: ${font}; font-size: 16px; line-height: 24px; font-weight: bold; color: ${t.buttonText}; text-decoration: none;">${btnLabel}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;

  const afterButtonCode = !afterButton
    ? ''
    : `
            <tr>
              <td class="em-text" style="padding: 0 32px 24px 32px; font-family: ${font}; font-size: 16px; line-height: 24px; color: ${t.text};">
                ${afterButton}
              </td>
            </tr>`;

  const footerCode = !footer
    ? ''
    : `
            <tr>
              <td class="em-footer" style="padding: 16px 32px 24px 32px; border-top: 1px solid ${t.border}; font-family: ${font}; font-size: 13px; line-height: 20px; color: ${t.footer};">
                ${footer}
              </td>
            </tr>`;

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${stripTags(header)}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <style>${darkModeCss}</style>
  <!--[if mso]><style>${msoCss}</style><![endif]-->
</head>
<body class="em-body" style="margin: 0; padding: 0; width: 100%; background-color: ${
    t.outer
  }; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
  ${preheaderCode}
  <table role="presentation" class="em-outer" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${
    t.outer
  }" style="background-color: ${t.outer};">
    <tr>
      <td align="center" style="padding: 24px 12px;">
        <!--[if mso]><table role="presentation" align="center" width="600" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
        <table role="presentation" class="em-card" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${
          t.surface
        }" style="max-width: 600px; margin: 0 auto; background-color: ${
    t.surface
  }; border: 1px solid ${t.border}; border-radius: 4px;">
          <tr>
            <td class="em-band" align="left" bgcolor="${
              t.band
            }" style="padding: 20px 32px; background-color: ${
    t.band
  }; background-image: linear-gradient(${t.band}, ${t.band}); border-radius: 4px 4px 0 0;">
              <img src="${baseUrl}${emailLogoPath}" width="${EMAIL_LOGO_WIDTH}" height="${EMAIL_LOGO_HEIGHT}" alt="Civitai" style="display: block; border: 0; outline: none; text-decoration: none; width: ${EMAIL_LOGO_WIDTH}px; height: ${EMAIL_LOGO_HEIGHT}px; font-family: ${font}; font-size: 22px; line-height: 30px; font-weight: bold; color: ${
    t.logoAlt
  };" />
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 32px 8px 32px;">
              <h1 class="em-h1" style="margin: 0; font-family: ${font}; font-size: 24px; line-height: 32px; font-weight: bold; color: ${
    t.text
  };">${header}</h1>
            </td>
          </tr>
          <tr>
            <td class="em-text" style="padding: 8px 32px 16px 32px; font-family: ${font}; font-size: 16px; line-height: 24px; color: ${
    t.text
  };">
              ${body}
            </td>
          </tr>${buttonCode}${afterButtonCode}${footerCode}
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
};
