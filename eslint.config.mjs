import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist/']),
  {
    files: ['**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended],
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
  },
]);
