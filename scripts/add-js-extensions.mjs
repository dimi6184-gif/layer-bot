#!/usr/bin/env node
// scripts/add-js-extensions.mjs
// Post-build script:
//   1. Replaces @nexus/db imports with correct relative path to db.js
//   2. Adds .js extensions to all relative imports in dist/ files
import { readdir, readFile, writeFile, cp } from 'fs/promises';
import { join, extname, relative, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');

async function getAllFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getAllFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

const files = await getAllFiles(distDir);

for (const file of files) {
  const original = await readFile(file, 'utf8');
  let updated = original;

  // 1. Replace @nexus/db with relative path to db.js
  const fileDir = dirname(file);
  const dbPath = relative(fileDir, join(distDir, 'db.js')).replace(/\\/g, '/');
  const dbImport = dbPath.startsWith('.') ? dbPath : './' + dbPath;

  updated = updated
    .replace(/from\s+'@nexus\/db'/g, `from '${dbImport}'`)
    .replace(/from\s+"@nexus\/db"/g, `from "${dbImport}"`)
    .replace(/import\('@nexus\/db'\)/g, `import('${dbImport}')`)
    .replace(/import\("@nexus\/db"\)/g, `import("${dbImport}")`);

  // 2. Add .js to relative imports without extension
  updated = updated
    .replace(/(from\s+['"])(\.{1,2}\/[^'"]+?)(['"])/g, (_, prefix, path, suffix) => {
      if (extname(path)) return _;
      return `${prefix}${path}.js${suffix}`;
    })
    .replace(/(import\(['"])(\.{1,2}\/[^'"]+?)(['"]\))/g, (_, prefix, path, suffix) => {
      if (extname(path)) return _;
      return `${prefix}${path}.js${suffix}`;
    });

  if (updated !== original) {
    await writeFile(file, updated, 'utf8');
    console.log(`✓ ${relative(distDir, file)}`);
  }
}
console.log(`\nDone! Processed ${files.length} files.`);

const srcAssets = join(__dirname, '..', 'assets');
const distAssets = join(distDir, 'assets');
try {
  await cp(srcAssets, distAssets, { recursive: true });
  console.log('✓ Copied assets to dist/assets');
} catch (e) {
  console.warn('Could not copy assets to dist:', e.message);
}
