import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [
  ...fs.readdirSync(path.join(root, 'public')).filter(f => f.endsWith('.js')).map(f => path.join(root, 'public', f)),
  path.join(root, 'client', 'citizen.mjs'),
];

for (const f of files) {
  test(`syntax: ${path.relative(root, f)}`, () => {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }));
  });
}
