// The shared transactional email layout. Layout only: branded copy stays in each app.

/**
 * Colour tokens for every email built on `renderEmailShell`, taken from the site theme (the main
 * app's `src/providers/ThemeProvider.tsx`): `band` is Mantine dark[7], the site's dark surface, and
 * `button`/`link` are blue[8]. blue[6] (#228BE6) is the site's usual primary but carries white text at
 * only about 3.6:1, so it is not used for the button. Surfaces are off-white rather than #fff so
 * clients that invert pure white in dark mode leave them alone. `panel` (gray[1] / dark[5]) is the
 * tinted surface of the summary block. The main app's `email-theme.test.ts` checks the WCAG
 * contrast of each text/background pair.
 */
export const emailTheme = {
  band: '#1A1B1E',
  outer: '#f8f9fa',
  surface: '#fefefe',
  panel: '#f1f3f5',
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
    panel: '#2C2E33',
    /** The heading, brighter than body text: the theme's white. */
    heading: '#fefefe',
    border: '#373A40',
    text: '#C1C2C5',
    footer: '#A6A7AB',
    link: '#4DABF7',
  },
} as const;

/**
 * Per-email accents, all from the site palette (ThemeProvider overrides plus the Mantine defaults
 * the site uses in its own gradients). `from`/`to` paint the stripe under the header band, with
 * `solid` as the colour for clients that drop gradients (classic Outlook). `text` is the eyebrow
 * and callout bar colour on the light card, `darkText` on the dark card; `tint`/`tintBorder` are
 * the light icon badge.
 */
export const emailAccents = {
  // The site's default gradient, cyan[6] -> blue[6].
  blue: {
    from: '#15AABF',
    to: '#228BE6',
    solid: '#228BE6',
    text: '#1971C2',
    darkText: '#4DABF7',
    tint: '#E7F5FF',
    tintBorder: '#A5D8FF',
  },
  // The site's Buzz gradient, yellow[4] -> orange[5]. Orange text fails AA on white, so the
  // eyebrow uses the theme's accent[9].
  buzz: {
    from: '#FFD43B',
    to: '#FF922B',
    solid: '#FCC419',
    text: '#88643B',
    darkText: '#FFD43B',
    tint: '#FFF9DB',
    tintBorder: '#FFE066',
  },
  // The theme's success scale.
  green: {
    from: '#1EBD8E',
    to: '#299C7A',
    solid: '#299C7A',
    text: '#326D5C',
    darkText: '#69DB7C',
    tint: '#EBFBEE',
    tintBorder: '#B2F2BB',
  },
  red: {
    from: '#ff6b6b',
    to: '#e03131',
    solid: '#e03131',
    text: '#c92a2a',
    darkText: '#ff8787',
    tint: '#fff5f5',
    tintBorder: '#ffc9c9',
  },
  // The site's violet -> blue gradient (memberships).
  violet: {
    from: '#7950F2',
    to: '#228BE6',
    solid: '#7950F2',
    text: '#6741D9',
    darkText: '#B197FC',
    tint: '#F3F0FF',
    tintBorder: '#D0BFFF',
  },
  gray: {
    from: '#ADB5BD',
    to: '#495057',
    solid: '#868E96',
    text: '#495057',
    darkText: '#A6A7AB',
    tint: '#F1F3F5',
    tintBorder: '#DEE2E6',
  },
} as const;
export type EmailAccent = keyof typeof emailAccents;

export const emailFontStack =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';

/**
 * Served by the main app from `public/`. The white-text wordmark with the band colour baked in, so a
 * client that inverts colours still shows it on dark.
 */
export const emailLogoPath = '/images/email/logo-dark-band@2x.png';
export const EMAIL_LOGO_WIDTH = 142;
export const EMAIL_LOGO_HEIGHT = 30;

/**
 * The footer's social links: the site's own profiles (the main app's `src/components/Meta/site-schema.ts`),
 * each with a 2x PNG of the Tabler icon the site footer uses: a light glyph on a dark disc with
 * transparent corners, so it reads on the light and the dark page alike and is never inverted.
 */
export const EMAIL_SOCIAL_LINKS = [
  {
    name: 'Discord',
    href: 'https://discord.gg/civitai',
    icon: '/images/email/social-discord@2x.png',
  },
  { name: 'X', href: 'https://twitter.com/HelloCivitai', icon: '/images/email/social-x@2x.png' },
  {
    name: 'Instagram',
    href: 'https://www.instagram.com/hellocivitai/',
    icon: '/images/email/social-instagram@2x.png',
  },
  {
    name: 'YouTube',
    href: 'https://www.youtube.com/@civitai',
    icon: '/images/email/social-youtube@2x.png',
  },
  {
    name: 'Reddit',
    href: 'https://reddit.com/r/civitai',
    icon: '/images/email/social-reddit@2x.png',
  },
] as const;
export const EMAIL_SOCIAL_ICON_SIZE = 32;

/** Class on the hidden preheader; the plain-text conversion skips it. */
export const EMAIL_PREHEADER_CLASS = 'em-preheader';
/**
 * Put this class on any element a caller styles with `emailTheme.muted`: an inline colour beats the
 * template's dark-mode rules, so without it the text would stay dark grey on the dark surface.
 */
export const EMAIL_MUTED_CLASS = 'em-muted';
/**
 * Classes on decoration the plain-text conversion skips: the icon badge and the social icons. Both sit
 * on a cell, not a table, so a layout-table rule cannot outrank them.
 */
export const EMAIL_DECORATION_CLASSES = ['em-badge', 'em-social'] as const;
/**
 * Class on each summary row. html-to-text writes table rows inline (only a layout TABLE is a
 * block), so without it every row of a summary runs together on one plain-text line.
 */
export const EMAIL_ROW_CLASS = 'em-row';

// Font family attributes are double-quoted, so the stack's own quotes become single quotes.
const font = emailFontStack.replace(/"/g, "'");
const t = emailTheme;

// The only CSS that is not inline: clients that honour prefers-color-scheme (Apple Mail, iOS Mail)
// get a deliberate dark surface instead of an automatic inversion. Inline styles win over a
// stylesheet, so every dark rule needs !important. The light rules above the media query only fill
// gaps a template left: a link with no inline colour gets the theme's instead of the client's
// default blue, and a body paragraph's default margin does not double the padding around it.
const darkModeCss = (accent: EmailAccent) => `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  .em-card a { color: ${t.link}; }
  .em-text p:first-child { margin-top: 0; }
  .em-text p:last-child { margin-bottom: 0; }
  @media (prefers-color-scheme: dark) {
    .em-body, .em-outer { background-color: ${t.dark.outer} !important; }
    .em-card { background-color: ${t.dark.surface} !important; border-color: ${t.dark.border} !important; }
    .em-text { color: ${t.dark.text} !important; }
    .em-h1 { color: ${t.dark.heading} !important; }
    .em-footer, .${EMAIL_MUTED_CLASS} { color: ${t.dark.footer} !important; border-color: ${t.dark.border} !important; }
    .em-card a:not(.em-btn) { color: ${t.dark.link} !important; }
    .em-eyebrow { color: ${emailAccents[accent].darkText} !important; }
    .em-badge, .em-panel { background-color: ${t.dark.panel} !important; border-color: ${t.dark.border} !important; }
    .em-callout { background-color: ${t.dark.panel} !important; }
    .em-page-footer, .em-page-footer a { color: ${t.dark.footer} !important; }
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
  /**
   * Origin of the site the email links to and loads its images from (no trailing slash): the logo,
   * the social icons, and the Terms, Privacy and Support links. Defaults to EMAIL_ASSET_ORIGIN.
   */
  baseUrl?: string;
  /** An emoji shown in a round badge above the heading. Decoration: plain text leaves it out. */
  icon?: string;
  /** Colours the stripe under the header band, the badge and the eyebrow. Defaults to blue. */
  accent?: EmailAccent;
  /** A short label above the heading, such as "Model training". Plain text, escaped by the caller. */
  eyebrow?: string;
};

/**
 * A tinted block of label/value rows, for the facts an email is about (a model and version, a
 * bounty, an amount). Values are inserted as HTML, so callers escape anything user-supplied. Each
 * row carries EMAIL_ROW_CLASS, which the plain-text part turns into its own line ("Label Value").
 */
export const renderEmailSummary = (rows: { label: string; value: string }[]) => {
  const cells = rows
    .map(
      ({ label, value }, i) => `
            <tr class="${EMAIL_ROW_CLASS}">
              <td class="${EMAIL_MUTED_CLASS}" style="padding: ${
        i === 0 ? '0' : '10px'
      } 16px 0 0; font-family: ${font}; font-size: 14px; line-height: 20px; color: ${
        t.muted
      }; vertical-align: top;">${label}</td>
              <td class="em-text" align="right" style="padding: ${
                i === 0 ? '0' : '10px'
              } 0 0 0; font-family: ${font}; font-size: 14px; line-height: 20px; font-weight: bold; color: ${
        t.text
      }; text-align: right; vertical-align: top; word-break: break-word;">${value}</td>
            </tr>`
    )
    .join('');
  return `<table role="presentation" class="em-panel" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${t.panel}" style="margin: 16px 0; background-color: ${t.panel}; border: 1px solid ${t.border}; border-radius: 8px;">
          <tr>
            <td style="padding: 16px 20px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">${cells}
              </table>
            </td>
          </tr>
        </table>`;
};

/**
 * A highlighted note with an accent bar on its left: a warning, a quoted message, a code to copy.
 * `content` is inserted as HTML. `mono` sets it in a monospace face that keeps line breaks.
 */
export const renderEmailCallout = (
  content: string,
  { accent = 'blue', mono = false }: { accent?: EmailAccent; mono?: boolean } = {}
) => {
  const a = emailAccents[accent];
  const face = mono
    ? "font-family: Menlo, Consolas, 'Courier New', monospace; font-size: 13px; line-height: 20px; white-space: pre-wrap; word-break: break-all;"
    : `font-family: ${font}; font-size: 15px; line-height: 22px;`;
  return `<table role="presentation" class="em-callout" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${a.tint}" style="margin: 16px 0; background-color: ${a.tint}; border-left: 4px solid ${a.solid}; border-radius: 4px;">
          <tr>
            <td class="em-text" style="padding: 14px 16px; ${face} color: ${t.text};">${content}</td>
          </tr>
        </table>`;
};

const renderBadge = (icon: string, accent: EmailAccent) => {
  const a = emailAccents[accent];
  return `
              <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0" style="margin: 0 auto 16px auto;">
                <tr>
                  <td class="em-badge" align="center" valign="middle" width="56" height="56" bgcolor="${a.tint}" style="width: 56px; height: 56px; background-color: ${a.tint}; border: 1px solid ${a.tintBorder}; border-radius: 28px; font-size: 28px; line-height: 56px; mso-line-height-rule: exactly; text-align: center;">${icon}</td>
                </tr>
              </table>`;
};

/**
 * The shared transactional email layout: a full XHTML document with a dark brand band carrying the
 * logo, an accent stripe, an optional icon badge and eyebrow over the heading, the body, an optional
 * button, optional text after the button and small print, and below the card the site's social
 * links and policy links.
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
  icon,
  accent = 'blue',
  eyebrow,
}: EmailShellInput) => {
  const a = emailAccents[accent];
  const preheaderCode = !preheader
    ? ''
    : `<div class="${EMAIL_PREHEADER_CLASS}" style="display: none; max-height: 0; max-width: 0; overflow: hidden; mso-hide: all; font-size: 1px; line-height: 1px; opacity: 0; color: ${t.outer};">${preheader}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>`;

  const badgeCode = icon ? renderBadge(icon, accent) : '';
  const eyebrowCode = !eyebrow
    ? ''
    : `
              <p class="em-eyebrow" style="margin: 0 0 8px 0; font-family: ${font}; font-size: 12px; line-height: 16px; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; color: ${a.text};">${eyebrow}</p>`;

  const buttonCode =
    !btnUrl || !btnLabel
      ? ''
      : `
          <tr>
            <td align="center" style="padding: 8px 32px 28px 32px;">
              <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>
                  <td class="em-btn-cell" align="center" bgcolor="${t.button}" style="border-radius: 8px; background-color: ${t.button}; mso-padding-alt: 12px 24px;">
                    <a class="em-btn" href="${btnUrl}" target="_blank" style="display: inline-block; padding: 12px 24px; min-width: 160px; border: 1px solid ${t.button}; border-radius: 8px; background-color: ${t.button}; font-family: ${font}; font-size: 16px; line-height: 24px; font-weight: bold; color: ${t.buttonText}; text-align: center; text-decoration: none;">${btnLabel}</a>
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

  const socialCode = EMAIL_SOCIAL_LINKS.map(
    ({ name, href, icon: path }) => `
                <td style="padding: 0 6px;"><a href="${href}" target="_blank" style="text-decoration: none;"><img src="${baseUrl}${path}" width="${EMAIL_SOCIAL_ICON_SIZE}" height="${EMAIL_SOCIAL_ICON_SIZE}" alt="${name}" style="display: block; border: 0; outline: none; width: ${EMAIL_SOCIAL_ICON_SIZE}px; height: ${EMAIL_SOCIAL_ICON_SIZE}px; font-family: ${font}; font-size: 10px; line-height: 12px; color: ${t.footer};" /></a></td>`
  ).join('');
  const pageLink = (href: string, label: string) =>
    `<a href="${href}" target="_blank" style="color: ${t.footer}; text-decoration: underline;">${label}</a>`;

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
  <style>${darkModeCss(accent)}</style>
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
      <td align="center" style="padding: 32px 12px 24px 12px;">
        <!--[if mso]><table role="presentation" align="center" width="600" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
        <table role="presentation" class="em-card" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${
          t.surface
        }" style="max-width: 600px; margin: 0 auto; background-color: ${
    t.surface
  }; border: 1px solid ${t.border}; border-radius: 12px;">
          <tr>
            <td class="em-band" align="left" bgcolor="${
              t.band
            }" style="padding: 22px 32px; background-color: ${
    t.band
  }; background-image: linear-gradient(${t.band}, ${t.band}); border-radius: 12px 12px 0 0;">
              <img src="${baseUrl}${emailLogoPath}" width="${EMAIL_LOGO_WIDTH}" height="${EMAIL_LOGO_HEIGHT}" alt="Civitai" style="display: block; border: 0; outline: none; text-decoration: none; width: ${EMAIL_LOGO_WIDTH}px; height: ${EMAIL_LOGO_HEIGHT}px; font-family: ${font}; font-size: 22px; line-height: 30px; font-weight: bold; color: ${
    t.logoAlt
  };" />
            </td>
          </tr>
          <tr>
            <td class="em-accent" height="4" bgcolor="${
              a.solid
            }" style="height: 4px; padding: 0; font-size: 4px; line-height: 4px; mso-line-height-rule: exactly; background-color: ${
    a.solid
  }; background-image: linear-gradient(90deg, ${a.from}, ${a.to});">&#8203;</td>
          </tr>
          <tr>
            <td align="center" style="padding: 36px 32px 8px 32px; text-align: center;">${badgeCode}${eyebrowCode}
              <h1 class="em-h1" style="margin: 0; font-family: ${font}; font-size: 26px; line-height: 34px; font-weight: bold; color: ${
    t.text
  }; text-align: center;">${header}</h1>
            </td>
          </tr>
          <tr>
            <td class="em-text" style="padding: 16px 32px 16px 32px; font-family: ${font}; font-size: 16px; line-height: 24px; color: ${
    t.text
  };">
              ${body}
            </td>
          </tr>${buttonCode}${afterButtonCode}${footerCode}
        </table>
        <table role="presentation" class="em-page-footer" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: 0 auto;">
          <tr>
            <td class="em-social" align="center" style="padding: 28px 16px 8px 16px;">
              <table role="presentation" align="center" border="0" cellspacing="0" cellpadding="0" style="margin: 0 auto;">
                <tr>${socialCode}
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="em-page-footer" align="center" style="padding: 8px 16px 8px 16px; font-family: ${font}; font-size: 13px; line-height: 20px; color: ${
    t.footer
  }; text-align: center;">
              ${pageLink(
                `${baseUrl}/content/tos`,
                'Terms of Service'
              )} &nbsp;&middot;&nbsp; ${pageLink(
    `${baseUrl}/content/privacy`,
    'Privacy'
  )} &nbsp;&middot;&nbsp; ${pageLink(`${baseUrl}/support`, 'Support')}
            </td>
          </tr>
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
};
