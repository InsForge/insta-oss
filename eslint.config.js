import tseslint from 'typescript-eslint'

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // ui/ has its own toolchain (Vite + tsc in `npm --prefix ui run build`); linting it here
  // would need the React plugin set and trips over ui/dist locally.
  { ignores: ['dist/', 'node_modules/', 'ui/'] },
)
