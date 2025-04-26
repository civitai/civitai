# Mantine v5 to v7 Migration Plan

## Overview
This document outlines the steps to migrate from Mantine v5 to v7, with a focus on replacing CSS-in-JS with CSS Modules and updating theme usage.

## Prerequisites
- Node.js 16+
- npm/yarn
- Git (for version control)

## Step 1: Update Dependencies
```bash
# Update Mantine packages
npm install @mantine/core@7 @mantine/hooks@7 @mantine/form@7 @mantine/notifications@7 @mantine/dates@7 @mantine/dropzone@7 @mantine/carousel@7 @mantine/modals@7 @mantine/spotlight@7 @mantine/nprogress@7

# Install required PostCSS dependencies
npm install postcss-preset-mantine postcss-simple-vars postcss-nested
```

## Step 2: Configure PostCSS
Create or update `postcss.config.js`:
```javascript
module.exports = {
  plugins: {
    'postcss-preset-mantine': {},
    'postcss-simple-vars': {
      variables: {
        'mantine-breakpoint-xs': '36em',
        'mantine-breakpoint-sm': '48em',
        'mantine-breakpoint-md': '62em',
        'mantine-breakpoint-lg': '75em',
        'mantine-breakpoint-xl': '88em',
      },
    },
  },
};
```

## Step 3: CSS-in-JS Migration
### A. Identify Components to Migrate
1. Search for `createStyles` usage:
```bash
grep -r "createStyles" src/
```

2. Search for `sx` prop usage:
```bash
grep -r "sx=" src/
```

### B. Migration Patterns
1. **Basic Component Migration**:
```typescript
// Before (v5)
const useStyles = createStyles((theme) => ({
  root: {
    backgroundColor: theme.colors.blue[5],
    padding: theme.spacing.md,
  },
}));

// After (v7)
// Component.module.css
.root {
  background-color: var(--mantine-color-blue-5);
  padding: var(--mantine-spacing-md);
}
```

2. **Theme Color Scheme Migration**:
```typescript
// Before (v5)
const useStyles = createStyles((theme) => ({
  root: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
  },
}));

// After (v7)
.root {
  background-color: var(--mantine-color-gray-0);
}

[data-mantine-color-scheme='dark'] .root {
  background-color: var(--mantine-color-dark-6);
}
```

3. **Responsive Styles Migration**:
```typescript
// Before (v5)
const useStyles = createStyles((theme) => ({
  root: {
    [theme.fn.smallerThan('sm')]: {
      flexDirection: 'column',
    },
  },
}));

// After (v7)
.root {
  @media (max-width: 48em) {
    flex-direction: column;
  }
}
```

## Step 4: Theme Provider Updates
1. Update theme configuration:
```typescript
// Before (v5)
<MantineProvider theme={{ colorScheme: 'dark' }}>

// After (v7)
<MantineProvider defaultColorScheme="dark">
```

2. Update color scheme usage:
```typescript
// Before (v5)
const { colorScheme } = useMantineTheme();

// After (v7)
const { colorScheme } = useMantineColorScheme();
```

## Step 5: Component Updates
1. Replace `sx` prop with `className` or `style`
2. Update component imports to use new paths
3. Update component props to match v7 API

## Step 6: Testing
1. Create test cases for each migrated component
2. Test dark/light mode switching
3. Test responsive behavior
4. Test theme customization

## Step 7: Cleanup
1. Remove unused CSS-in-JS dependencies
2. Remove unused theme-related code
3. Update documentation

## Migration Order
1. Start with simple components (few styles, no theme dependencies)
2. Move to components with theme usage
3. Handle complex components with multiple styles
4. Update layout components
5. Update form components
6. Update modal and notification components

## Notes
- Keep a backup of each file before migration
- Commit changes after each component migration
- Test thoroughly after each migration
- Use CSS variables for theme values
- Consider using CSS Modules for better maintainability

## Resources
- [Mantine v7 Documentation](https://v7.mantine.dev/)
- [Migration Guide](https://v7.mantine.dev/guides/6x-to-7x/)
- [CSS Modules Guide](https://v7.mantine.dev/styles/css-modules/)
