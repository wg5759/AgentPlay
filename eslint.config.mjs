import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactPlugin from 'eslint-plugin-react'

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2020, sourceType: 'module', ecmaFeatures: { jsx: true } },
      globals: { window: 'readonly', document: 'readonly', console: 'readonly', localStorage: 'readonly', URL: 'readonly', MediaRecorder: 'readonly', navigator: 'readonly', HTMLVideoElement: 'readonly', HTMLAudioElement: 'readonly', AbortController: 'readonly', ResizeObserver: 'readonly' }
    },
    plugins: { '@typescript-eslint': tsPlugin, react: reactPlugin },
    rules: {
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'warn'
    }
  },
  { ignores: ['dist', 'release', 'node_modules', 'resources', 'android', 'electron'] }
]
