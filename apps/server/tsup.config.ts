import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  // 共有パッケージは TS ソースのまま参照しているので同梱する
  noExternal: ['@pos/shared'],
});
