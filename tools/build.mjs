/** Builds build/extension/ from src/ and static/. */
import { build, context } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'build/extension');
const watch = process.argv.includes('--watch');

const ENTRIES = {
  'driver.js': 'src/entries/driver.js',
  'bridge.js': 'src/entries/bridge.js',
  'panel.js': 'src/entries/panel.js',
  'service-worker.js': 'src/entries/worker.js',
};

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
await fs.cp(path.join(root, 'static'), out, { recursive: true });

const options = (name, entry) => ({
  entryPoints: [path.join(root, entry)],
  outfile: path.join(out, name),
  bundle: true,
  format: 'iife',
  target: 'chrome111',
  platform: 'browser',
  legalComments: 'none',
  sourcemap: watch ? 'inline' : false,
});

const jobs = Object.entries(ENTRIES);

if (watch) {
  const contexts = await Promise.all(jobs.map(([n, e]) => context(options(n, e))));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching');
} else {
  await Promise.all(jobs.map(([n, e]) => build(options(n, e))));
  console.log(`built ${jobs.length} bundles → ${path.relative(root, out)}`);
}
