module.exports = {
  plugins: {
    tailwindcss: {},
    'postcss-preset-mantine': {},
    'postcss-simple-vars': {
      variables: {
        'mantine-breakpoint-xs': '30em',
        'mantine-breakpoint-sm': '48em',
        'mantine-breakpoint-md': '64em',
        'mantine-breakpoint-lg': '74em',
        'mantine-breakpoint-xl': '90em',
      },
    },
    autoprefixer: {},
    // Wrap every CSS Module's output in a `modules` cascade layer. Unlayered
    // Tailwind utilities (see src/styles/globals.css) then always beat module
    // styles regardless of Turbopack's CSS injection order — the root cause of
    // module rules overriding Tailwind after the Next 16 / Turbopack switch.
    // Value is the array the plugin expects; runs before cssnano so the
    // @layer wrapper is in place before minification.
    'postcss-assign-layer': [
      { include: '**/*.module.css', layerName: 'modules' },
      { include: '**/*.module.scss', layerName: 'modules' },
    ],
    ...(process.env.NODE_ENV === 'production' ? { cssnano: {} } : {})
  }
}
