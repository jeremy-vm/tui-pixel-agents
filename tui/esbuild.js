// esbuild build script for the tui package
import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** Resolve a path relative to the tui/ directory */
const r = (...parts) => resolve(__dirname, ...parts);

// Read root package.json version
const rootPkg = JSON.parse(readFileSync(r('../package.json'), 'utf-8'));

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: [r('src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: r('dist/index.js'),
  define: {
    'process.env.TUI_VERSION': JSON.stringify(rootPkg.version),
  },
  // Look for node_modules in both tui/ and root directories
  nodePaths: [r('node_modules'), r('../node_modules')],
  // Resolve packages from root node_modules as fallback
  plugins: [
    {
      name: 'root-node-modules',
      setup(build) {
        // Intercept .js imports and try .ts first
        build.onResolve({ filter: /\.js$/ }, (args) => {
          if (!args.path.startsWith('.')) return null;
          const base = args.path.slice(0, -3);
          const tsPath = resolve(dirname(args.importer), base + '.ts');
          try {
            readFileSync(tsPath);
            return { path: tsPath };
          } catch {
            return null;
          }
        });

        // Resolve bare package specifiers from root node_modules
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          const rootNm = r('../node_modules');
          const candidates = [
            resolve(rootNm, args.path),
            resolve(rootNm, args.path, 'index.js'),
            resolve(rootNm, args.path + '.js'),
          ];
          for (const c of candidates) {
            try {
              readFileSync(c);
              return { path: c };
            } catch {
              continue;
            }
          }
          // Try the package.json main field
          try {
            const pkgPath = resolve(rootNm, args.path, 'package.json');
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            const main = pkg.main ?? 'index.js';
            const mainPath = resolve(rootNm, args.path, main);
            readFileSync(mainPath);
            return { path: mainPath };
          } catch {
            return null;
          }
        });
      },
    },
  ],
  // Keep CJS modules external — Node.js handles CJS/ESM interop at runtime
  external: ['pngjs'],
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('Build complete → dist/index.js');
}
