#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';

const target = process.argv[2];
const limit = Number(process.argv[3] ?? 30);

if (!target) {
  console.error('Usage: npm run size:ios -- path/to/App.ipa|Payload/App.app [top-file-count]');
  process.exit(1);
}

function bytesToHuman(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function walkFiles(root) {
  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile()) {
        const size = statSync(path).size;
        files.push({ path, size });
      }
    }
  }

  return files;
}

function directorySize(root) {
  return walkFiles(root).reduce((total, file) => total + file.size, 0);
}

let cleanupDir;
let appPath = target;

if (extname(target).toLowerCase() === '.ipa') {
  cleanupDir = mkdtempSync(join(tmpdir(), 'fcdownloader-ipa-'));
  execFileSync('unzip', ['-q', target, '-d', cleanupDir], { stdio: 'ignore' });

  const payloadDir = join(cleanupDir, 'Payload');
  const app = readdirSync(payloadDir).find((name) => name.endsWith('.app'));
  if (!app) {
    throw new Error(`No .app bundle found in ${target}`);
  }
  appPath = join(payloadDir, app);
}

try {
  const files = walkFiles(appPath).sort((a, b) => b.size - a.size);
  const total = directorySize(appPath);

  console.log(`${basename(appPath)} uncompressed app size: ${bytesToHuman(total)}`);
  console.log(`Top ${Math.min(limit, files.length)} files:`);

  for (const file of files.slice(0, limit)) {
    console.log(`${bytesToHuman(file.size).padStart(8)}  ${relative(appPath, file.path)}`);
  }
} finally {
  if (cleanupDir) {
    rmSync(cleanupDir, { recursive: true, force: true });
  }
}
