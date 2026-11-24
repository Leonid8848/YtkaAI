import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const credsPath = join0(process.cwd(), '.siwc', 'credentials.json');
function join0(...parts) {
  return parts.join('/');
}

if (!existsSync(credsPath)) {
  console.error('credentials not found, run scripts/siwc-login.mjs first');
  process.exit(1);
}
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
if (!creds.access_token || !creds.refresh_token) {
  console.error('credentials file has no tokens');
  process.exit(1);
}

function put(name, value) {
  const res = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', name], {
    input: value,
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  if (res.status !== 0) {
    console.error(`${name} failed`, (res.stderr || res.stdout || '').slice(0, 400));
    process.exit(1);
  }
  console.log(`${name} updated`);
}

put('SIWC_ACCESS_TOKEN', creds.access_token);
put('SIWC_REFRESH_TOKEN', creds.refresh_token);
