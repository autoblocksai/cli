/** @type {import("eslint").Linter.Config} */
const config = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'prettier'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/eslint-recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    'prettier/prettier': 'error',
    // Console logging interferes with ink's output,
    // so logging should go through the dedicated logger.
    'no-console': 'error',
    'no-restricted-imports': [
      'error',
      {
        // Importing process directly prevents tsup
        // from bundling compile-time variables.
        paths: ['process'],
      },
    ],
  },
  ignorePatterns: ['dist/**'],
};

module.exports = config;
