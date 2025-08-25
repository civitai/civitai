import { isNumber } from '~/utils/type-guards';

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

export function waitForElement({
  selector,
  timeout = 5000,
  interval = 500,
}: {
  selector: string;
  timeout?: number;
  interval?: number;
}) {
  return new Promise<Element | null>((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      if (Date.now() - startTime > timeout) {
        reject(new Error(`Timeout waiting for element: ${selector}`));
        return;
      }

      setTimeout(check, interval);
    };

    check();
  });
}

export function findNearestAncestorWithProps<TReturn>(
  el: HTMLElement | null,
  cb: (elem: HTMLElement) => TReturn | undefined
) {
  while (el) {
    const result = cb(el);
    if (result) return result;
    el = el.parentElement;
  }
}
