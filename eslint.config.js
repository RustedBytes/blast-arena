// Lint rules for the TypeScript client: typescript-eslint's strict,
// type-aware rule sets.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import compat from 'eslint-plugin-compat';

export default tseslint.config(
  { ignores: ['static/', 'target/', 'node_modules/', 'eslint.config.js'] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  // Flags browser APIs missing from the targets in package.json's browserslist.
  compat.configs['flat/recommended'],
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Numbers in template strings are fine (CSS values, labels).
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `() => doSomething()` callbacks read naturally.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },
  {
    // Node build scripts: plain JavaScript, so no type-aware rules.
    files: ['scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
