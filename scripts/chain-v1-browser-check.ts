import { build } from 'vite';
await build({ configFile: false, publicDir: false, build: { outDir: '.tmp/chain-v1/browser', emptyOutDir: true, target: 'es2022', lib: { entry: 'src/chain-v1/client.ts', formats: ['es'], fileName: 'client' }, rollupOptions: { onwarn(warning, warn) { if (warning.code === 'MODULE_LEVEL_DIRECTIVE')
                return; if (warning.message.includes('externalized for browser compatibility'))
                throw Error(warning.message); warn(warning); } } } });
