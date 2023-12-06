import sanitize, { Transformer } from 'sanitize-html';
import linkBlocklist from '~/server/utils/link-blocklist.json';
import { isNumber, isValidURL } from '~/utils/type-guards';

export type santizeHtmlOptions = sanitize.IOptions & { stripEmpty?: boolean };
export function sanitizeHtml(
  html: string,
  { stripEmpty, ...options }: santizeHtmlOptions = { stripEmpty: false }
) {
  return sanitize(html, {
    allowedTags: [
      'p',
      'strong',
      'em',
      'u',
      's',
      'ul',
      'ol',
      'li',
      'a',
      'br',
      'img',
      'iframe',
      'div',
      'code',
      'pre',
      'span',
      'h1',
      'h2',
      'h3',
      'hr',
    ],
    allowedAttributes: {
      a: ['rel', 'href', 'target'],
      img: ['src', 'alt', 'width', 'height'],
      iframe: [
        'src',
        'width',
        'height',
        'allowfullscreen',
        'autoplay',
        'disablekbcontrols',
        'enableiframeapi',
        'endtime',
        'ivloadpolicy',
        'loop',
        'modestbranding',
        'origin',
        'playlist',
        'start',
      ],
      div: ['data-youtube-video', 'data-type'],
      span: ['class', 'data-type', 'data-id', 'data-label', 'style'],
      '*': ['id'],
    },
    exclusiveFilter: stripEmpty
      ? (frame) => {
          return (
            frame.tag === 'p' && // The node is a p tag
            !frame.text.trim() // The element has no text
          );
        }
      : undefined,
    allowedIframeHostnames: ['www.youtube.com', 'www.instagram.com', 'www.strawpoll.com'],
    transformTags: {
      a: function (tagName, { href, ...attr }) {
        const updatedHref = href.startsWith('http') ? href : `http://${href}`;
        const hrefDomain = isValidURL(updatedHref) ? new URL(updatedHref).hostname : undefined;
        if (!hrefDomain) return { tagName: 'span', ...attr };

        const isBlocked = linkBlocklist.some((domain) => domain === hrefDomain);
        if (isBlocked)
          return {
            tagName: 'span',
            text: '[Blocked Link]',
          };
        return {
          tagName: 'a',
          attribs: {
            ...attr,
            href,
            rel: 'ugc',
          },
        };
      } as Transformer,
    },
    ...options,
  });
}

/**
 * GitHub Copilot made this :^) -Manuel
 */
export function isLightColor(hexColor: string) {
  const hex = hexColor.startsWith('#') ? hexColor.replace('#', '') : hexColor;
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 2), 16);
  const b = parseInt(hex.substring(4, 2), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;

  return yiq >= 128;
}

/**
 * Thrown together with ChatGPT :^) -Manuel
 */
type ColorSwapOptions = { hexColor: string; colorScheme: 'dark' | 'light'; threshold?: number };
export function needsColorSwap({ hexColor, colorScheme, threshold = 0.5 }: ColorSwapOptions) {
  // Remove the '#' symbol if present
  hexColor = hexColor.startsWith('#') ? hexColor.replace('#', '') : hexColor;

  // Convert the hex color to RGB values
  const r = parseInt(hexColor.substring(0, 2), 16);
  const g = parseInt(hexColor.substring(2, 4), 16);
  const b = parseInt(hexColor.substring(4), 16);

  // Calculate the relative luminance of the color
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (!isNumber(luminance)) return false;

  // Compare the luminance to a threshold value
  if (colorScheme === 'dark') {
    if (luminance > threshold) {
      // Color is closer to white (light)
      return false;
    } else {
      // Color is closer to black (dark)
      return true;
    }
  } else {
    if (luminance > threshold) {
      // Color is closer to white (light)
      return true;
    } else {
      // Color is closer to black (dark)
      return false;
    }
  }
}
