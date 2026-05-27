import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const SERVER_SOURCE_DIRS = [
  'src/config',
  'src/index.ts',
  'src/layers',
  'src/sdk',
  'src/services',
  'src/tools',
];

const STDOUT_PATTERNS = [
  /\bconsole\.log\s*\(/,
  /\bconsole\.info\s*\(/,
  /\bconsole\.debug\s*\(/,
  /\bprocess\.stdout\s*\./,
  /\bstdout\.write\s*\(/,
];

function collectTypeScriptFiles(path: string): string[] {
  const fullPath = join(process.cwd(), path);
  const stats = statSync(fullPath);

  if (stats.isFile()) {
    return path.endsWith('.ts') ? [fullPath] : [];
  }

  return readdirSync(fullPath).flatMap((entry) => {
    const childPath = join(fullPath, entry);
    const childStats = statSync(childPath);

    if (childStats.isDirectory()) {
      return collectTypeScriptFiles(relative(process.cwd(), childPath));
    }

    return childPath.endsWith('.ts') ? [childPath] : [];
  });
}

describe('MCP stdio logging safety', () => {
  it('does not write diagnostics to stdout from server code', () => {
    const violations = SERVER_SOURCE_DIRS
      .flatMap(collectTypeScriptFiles)
      .flatMap((filePath) => {
        const source = readFileSync(filePath, 'utf8');

        return source
          .split(/\r?\n/)
          .map((line, index) => ({ line, lineNumber: index + 1 }))
          .filter(({ line }) => STDOUT_PATTERNS.some((pattern) => pattern.test(line)))
          .map(({ line, lineNumber }) => `${relative(process.cwd(), filePath)}:${lineNumber}: ${line.trim()}`);
      });

    expect(violations).toEqual([]);
  });
});
