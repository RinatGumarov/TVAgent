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
    files: ['extension/src/**/*.js', 'src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    // The worker is a service worker, not a page.
    files: ['extension/src/background/**/*.js', 'src/background/**/*.ts'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // Classic scripts share code through these. They go away with the move to
    // ES modules.
    files: ['extension/src/**/*.js'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'TVAgentWire',
          'TVAgentWait',
          'TVAgentModels',
          'TVAgentCredentials',
          'TVAgentProviderURL',
          'TVAgentBridge',
          'TVAgentTools',
          'TVAgentRuntime',
          'TVAgentChat',
          'TVAgentSettings',
          'TVAgentMount',
        ].map((name) => [name, 'readonly']),
      ),
    },
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
