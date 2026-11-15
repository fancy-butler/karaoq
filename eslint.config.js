// Catches the bugs that are easy to miss in plain JS: undefined names, typos, unreachable code.
const globals = require('globals');
const js = require('@eslint/js');

const rules = {
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-empty': 'off',
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-self-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-control-regex': 'off',
  'no-useless-escape': 'off',
  'no-cond-assign': ['error', 'except-parens'],
  'no-async-promise-executor': 'off',
  'no-prototype-builtins': 'off',
};

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'bin/**', 'webkit-shots/**', 'data/**'] },
  js.configs.recommended,
  { files: ['server.js', 'lib/**/*.js', 'scripts/**/*.js', 'desktop/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } }, rules },
  // test drivers run some code inside the browser page
  { files: ['scripts/smoke.js', 'scripts/webkit-check.js'], languageOptions: { globals: { ...globals.browser, KQ: 'readonly', KQMic: 'readonly', KQRecap: 'readonly' } } },
  { files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script',
      globals: { ...globals.browser, KQ: 'readonly', KQMic: 'readonly', KQRecap: 'readonly', KQStage: 'readonly', registerProcessor: 'readonly', AudioWorkletProcessor: 'readonly', sampleRate: 'readonly', currentTime: 'readonly' } }, rules },
];
