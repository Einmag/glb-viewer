import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Keep Vite's dependency cache outside Dropbox to avoid file lock/sync conflicts.
const externalCacheDir = resolve(tmpdir(), 'glb-viewer-vite-cache');

export default defineConfig({
  cacheDir: externalCacheDir
});
