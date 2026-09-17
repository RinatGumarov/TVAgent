import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['build/', 'dist/', 'docs/', 'node_modules/'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    files: ['src/**/*.{js,ts}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    // The worker is a service worker, not a page.
    files: ['src/background/**/*.{js,ts}', 'src/entries/worker.{js,ts}'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.webextensions } },
  },
  {
    files: ['tests/**', 'tools/**', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
