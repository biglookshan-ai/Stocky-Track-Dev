import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// `node --check` only parses; it cannot see that a name used at module scope was
// never imported. That shipped a broken deploy once: a route list was referenced
// without its import, every page answered 502, and nothing caught it until the
// site was down. Loading the module in a subprocess runs all of its top-level
// code, which is exactly what would throw.
test('server.js loads without an undefined reference', async () => {
  const { stderr } = await run(
    process.execPath,
    ['-e', "import('./src/server.js').catch((error) => { console.error(error.message); process.exit(2); })"],
    {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DATABASE_URL: '', PORT: '0' },
      timeout: 20_000,
    },
  ).catch((error) => error);

  // Reaching the database check means every import resolved and every
  // module-level statement ran. Anything else is a real defect.
  assert.match(
    String(stderr),
    /DATABASE_URL not set/,
    `server.js failed before reaching its database check:\n${stderr}`,
  );
  assert.doesNotMatch(String(stderr), /is not defined|Cannot find module/);
});
