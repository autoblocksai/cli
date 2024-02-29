import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  clean: true,
  env: {
    TSUP_PUBLIC_AUTOBLOCKS_INGESTION_KEY:
      process.env.TSUP_PUBLIC_AUTOBLOCKS_INGESTION_KEY,
  },
});
