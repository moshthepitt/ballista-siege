import { defineConfig } from 'vite';
import { validateManifestForBuild } from '../scripts/manifest-v1.js';
import { currentRunLayout } from '../scripts/generate-run-layout.js';
import { RUN_LAYOUT } from '../src/chain-v1/run-layout.js';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ command }) => ({
  base: './',
  build: { cssMinify: 'lightningcss', assetsDir: '' },
  plugins: [{
    name: 'inline-styles',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) if (item.type === 'asset' && item.fileName.endsWith('.html')) {
        let html = String(item.source);
        html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (tag, href: string) => {
          const name = href.replace(/^\.\//, ''), css = bundle[name];
          if (!css || css.type !== 'asset') throw new Error(`Missing stylesheet: ${href}`);
          delete bundle[name]; return `<style>${String(css.source).replaceAll('</style', '<\\/style')}</style>`;
        });
        item.source = html;
      }
    },
  }, {
    name: 'deployment-at-build',
    generateBundle(_options, bundle) {
      const modules = Object.fromEntries(Object.entries(bundle).filter(([,item]) => item.type === 'chunk').map(([name,item]) => [name, item.type === 'chunk' ? Object.keys(item.modules) : []]));
      mkdirSync('.tmp/dp1', { recursive: true }); writeFileSync('.tmp/dp1/bundle-modules.json', JSON.stringify(modules, null, 2));
    },
    resolveId(id) { if (id === 'virtual:deployment') return '\0deployment'; },
    async load(id) {
      if (id !== '\0deployment') return;
      const local = new URL('./deployments/localnet.json', import.meta.url);
      const file = command === 'serve' && existsSync(local) ? local : new URL('./deployments/devnet.json', import.meta.url);
      this.addWatchFile(fileURLToPath(file));
      if (JSON.stringify(RUN_LAYOUT) !== JSON.stringify(await currentRunLayout())) throw new Error('Stale browser layout. Run pnpm generate:wire.');
      const value = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
      if (value) await validateManifestForBuild(value);
      return `export default ${JSON.stringify(value)};`;
    },
  }],
}));
