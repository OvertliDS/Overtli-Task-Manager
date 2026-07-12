import fs from 'node:fs';
import { after } from 'node:test';

// The regression suites deliberately create real filesystem stores, workspaces,
// SQLite databases, and child-process fixtures. Track every test-process temp
// directory and remove it after the test file completes so local and CI runs do
// not accumulate durable-looking OTM state under the operating-system temp dir.
const originalMkdtempSync = fs.mkdtempSync.bind(fs);
const temporaryDirectories = new Set();

fs.mkdtempSync = function trackedMkdtempSync(...args) {
  const directory = originalMkdtempSync(...args);
  temporaryDirectories.add(directory);
  return directory;
};

after(() => {
  for (const directory of [...temporaryDirectories].reverse()) {
    try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
  }
});
