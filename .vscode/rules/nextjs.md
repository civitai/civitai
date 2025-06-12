---
description: Best Practices for Next.js
globs: src/**/*.{ts,tsx}
alwaysApply: false
---

Syntax and Formatting:

- Use the "function" keyword for pure functions.
- Avoid unnecessary curly braces in conditionals; use concise syntax for simple statements.
- Use declarative JSX.

Accessibility

- Ensure interfaces are keyboard navigable.
- Implement proper ARIA labels and roles for components.
- Ensure color contrast ratios meet WCAG standards for readability.

Next.js Specifics:

- Use client components sparingly, only when interactivity is required
- Take advantage of Next.js file-based routing system for simplicity
- Implement custom error pages with `error.tsx` to handle errors gracefully
- Use API route handlers to manage backend logic within the app structure
- Store shared logic in `lib/` or `util/`.
- Place static assets in `public/`.
- Wrap client components in Suspense with fallback
- Use dynamic loading for non-critical components
- Optimize images: use WebP format, include size data, implement lazy loading
- Optimize Web Vitals (LCP, CLS, FID)
- Refer to Next.js 14 documentation for Data Fetching, Rendering, and Routing best practices
