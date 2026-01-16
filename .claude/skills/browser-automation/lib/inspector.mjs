/**
 * Page Inspector
 *
 * Provides page inspection capabilities for AI agents to explore
 * and build recipes interactively.
 */

import { chromium } from 'playwright';
import { createContextCollector } from './context.mjs';

/**
 * Inspect a page and return structured data about what's visible
 * @param {Page} page - Playwright page
 * @param {Object} options - Options
 * @param {string} options.screenshotPath - Path to save screenshot
 * @returns {Object} Page inspection data
 */
export async function inspectPage(page, options = {}) {
  const screenshot = options.screenshotPath || `/tmp/inspect-${Date.now()}.png`;
  await page.screenshot({ path: screenshot, fullPage: false }); // Viewport only for speed

  const inspection = await page.evaluate(() => {
    // Helper to generate a usable selector
    function getSelector(el) {
      if (el.id) return `#${el.id}`;
      if (el.dataset.testid) return `[data-testid="${el.dataset.testid}"]`;
      if (el.name) return `[name="${el.name}"]`;

      // For links, prefer href-based selector
      if (el.tagName === 'A' && el.getAttribute('href')) {
        const href = el.getAttribute('href');
        if (href && !href.startsWith('javascript:') && href !== '#') {
          return `a[href='${href}']`;
        }
      }

      // For buttons with text
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
        const text = el.textContent?.trim();
        if (text && text.length < 30) {
          return `button:has-text('${text.replace(/'/g, "\\'")}')`;
        }
      }

      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (classes) return `${el.tagName.toLowerCase()}.${classes}`;
      }

      return el.tagName.toLowerCase();
    }

    function isVisible(el) {
      if (!el.offsetParent && el.tagName !== 'BODY') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' &&
             style.visibility !== 'hidden' &&
             style.opacity !== '0';
    }

    function isInViewport(el) {
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0 &&
             rect.left < window.innerWidth && rect.right > 0;
    }

    // Get clickable elements (buttons, links)
    const clickable = [];
    const seen = new Set();

    // Buttons
    document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach(el => {
      if (!isVisible(el)) return;
      const text = el.textContent?.trim() || el.value || '';
      const selector = getSelector(el);
      const key = `${selector}-${text}`;
      if (seen.has(key)) return;
      seen.add(key);

      clickable.push({
        type: 'button',
        text: text.substring(0, 50),
        selector,
        inViewport: isInViewport(el),
        enabled: !el.disabled,
      });
    });

    // Links (separate from buttons to avoid dedup issues)
    const links = [];
    document.querySelectorAll('a[href]').forEach(el => {
      if (!isVisible(el)) return;
      const href = el.getAttribute('href');
      if (!href || href === '#' || href.startsWith('javascript:')) return;

      const text = el.textContent?.trim() || '';
      // Skip if no meaningful text or href
      if (!text && href.startsWith('/')) return;

      const selector = getSelector(el);

      links.push({
        text: text.substring(0, 50),
        href: href.substring(0, 100),
        selector,
        inViewport: isInViewport(el),
      });
    });

    // Form inputs
    const inputs = [];
    document.querySelectorAll('input, textarea, select').forEach(el => {
      if (!isVisible(el) || el.type === 'hidden') return;

      inputs.push({
        type: el.type || el.tagName.toLowerCase(),
        name: el.name || el.id || '',
        selector: getSelector(el),
        placeholder: el.placeholder || '',
        value: el.type === 'password' ? '(password)' : (el.value?.substring(0, 50) || ''),
        required: el.required,
        inViewport: isInViewport(el),
      });
    });

    // Text content for context
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .filter(isVisible)
      .slice(0, 5)
      .map(el => el.textContent?.trim().substring(0, 100));

    // Error/alert messages
    const alerts = Array.from(document.querySelectorAll('[role="alert"], .error, .alert, .error-message'))
      .filter(isVisible)
      .filter(el => el.textContent?.trim())
      .slice(0, 3)
      .map(el => el.textContent?.trim().substring(0, 200));

    return {
      url: window.location.href,
      title: document.title,
      headings,
      alerts,
      buttons: clickable.slice(0, 20), // Limit for readability
      links: links.slice(0, 20),
      inputs: inputs.slice(0, 15),
    };
  });

  return {
    ...inspection,
    screenshot,
  };
}

/**
 * Interactive browser session for exploration
 */
export class BrowserSession {
  constructor(options = {}) {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.collector = null;
    this.headless = options.headless ?? false;
    this.slowMo = options.slowMo ?? 0;
    this.actions = []; // Record actions for recipe building
  }

  async start() {
    this.browser = await chromium.launch({
      headless: this.headless,
      slowMo: this.slowMo,
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30000);
    this.collector = createContextCollector(this.page);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async navigate(url) {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait a bit for JS to render
    await this.page.waitForTimeout(2000);
    this.actions.push({ action: 'navigate', url });
    return this.inspect();
  }

  async click(selector) {
    try {
      await this.page.waitForSelector(selector, { state: 'visible', timeout: 5000 });

      // Check if link and wait for navigation
      const isLink = await this.page.evaluate(sel => {
        const el = document.querySelector(sel);
        return el?.tagName === 'A' && el?.href;
      }, selector);

      if (isLink) {
        await Promise.all([
          this.page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
          this.page.click(selector)
        ]);
      } else {
        await this.page.click(selector);
        await this.page.waitForTimeout(500); // Wait for any JS
      }

      this.actions.push({ action: 'click', selector });
      return { success: true, inspection: await this.inspect() };
    } catch (e) {
      return { success: false, error: e.message, inspection: await this.inspect() };
    }
  }

  async type(selector, text) {
    try {
      await this.page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
      await this.page.fill(selector, '');
      await this.page.fill(selector, text);
      this.actions.push({ action: 'type', selector, text });
      return { success: true, inspection: await this.inspect() };
    } catch (e) {
      return { success: false, error: e.message, inspection: await this.inspect() };
    }
  }

  async inspect() {
    return inspectPage(this.page);
  }

  async screenshot(name) {
    const path = `/tmp/${name || 'screenshot'}-${Date.now()}.png`;
    await this.page.screenshot({ path, fullPage: true });
    return path;
  }

  getRecordedActions() {
    return this.actions;
  }

  generateRecipe(name, description) {
    return {
      name,
      description,
      steps: this.actions.map(action => {
        switch (action.action) {
          case 'navigate':
            return { navigate: action.url };
          case 'click':
            return { click: action.selector };
          case 'type':
            return { type: { selector: action.selector, text: action.text } };
          default:
            return action;
        }
      }),
    };
  }
}

/**
 * One-shot page inspection (opens browser, inspects, closes)
 */
export async function inspectUrl(url, options = {}) {
  const session = new BrowserSession(options);
  try {
    await session.start();
    const result = await session.navigate(url);
    return result;
  } finally {
    await session.close();
  }
}
