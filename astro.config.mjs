// @ts-check
import { defineConfig } from 'astro/config';

// Static output, zero integrations, two routes: the simulation and its
// explainer. The page bundles the simulation engine from service/engine
// (pure TypeScript, no dependencies) and runs it in the browser; nothing is
// requested from anywhere once the page has loaded.
export default defineConfig({
  vite: { server: { fs: { allow: ['.'] } } },
});
