// Lint rules for the TypeScript client: typescript-eslint's strict,
// type-aware rule sets.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['static/', 'target/', 'node_modules/', 'eslint.config.js'] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Numbers in template strings are fine (CSS values, labels).
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `() => doSomething()` callbacks read naturally.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },
);
