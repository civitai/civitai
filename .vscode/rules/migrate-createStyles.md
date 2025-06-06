# Instructions for Converting Styles to SCSS and Integrating Them

## Step 1: Convert Styles to SCSS
1. Provide the styles in JavaScript/TypeScript format (e.g., `createStyles` or inline styles).
2. Specify that the styles should be converted to SCSS.
3. Use Mantine variables and the `light-dark` function for color scheme adjustments, if applicable.
4. Create a new SCSS file with the same name as the `.tsx` file but with the `.module.scss` extension in the same directory.

## Step 2: Integrate the SCSS File
1. Import the newly created SCSS file into the corresponding `.tsx` file.
2. Replace the usage of `createStyles` or inline styles with the SCSS module.

## Example Request
If you want to apply this process to another file, you can say:
> "Convert the styles in `example.tsx` to SCSS using Mantine variables and the `light-dark` function. Create a new SCSS file named `example.module.scss` in the same directory and replace the usage of `createStyles` in `example.tsx` with the SCSS module."

## Notes
- Ensure that the SCSS file uses Mantine's design tokens and follows best practices for maintainability.
- Verify that the `.tsx` file correctly imports and applies the SCSS module after the conversion.