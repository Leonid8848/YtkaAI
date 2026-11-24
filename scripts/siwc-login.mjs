import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const APP_NAME = 'YtkaAI';
const HOST_FILE = join(process.cwd(), '.siwc', 'host.json');
const CREDS_FILE = join(process.cwd(), '.siwc', 'credentials.json');

const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const RESOURCE = 'https://api.openai.com/v1';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function atomicWrite(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

function loadHostId() {
  if (existsSync(HOST_FILE)) return JSON.parse(readFileSync(HOST_FILE, 'utf8')).ext_agent_host_id;
  const hostId = `urn:uuid:${randomUUID()}`;
  atomicWrite(HOST_FILE, JSON.stringify({ ext_agent_host_id: hostId }, null, 2));
  return hostId;
}

function randomUUID() {
  return randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

const hostId = loadHostId();

let savedClientId = null;
let savedIdToken = null;
if (existsSync(CREDS_FILE)) {
  const prev = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
  savedClientId = prev.client_id ?? null;
  savedIdToken = prev.id_token ?? null;
}

const state = b64url(randomBytes(24));
const nonce = b64url(randomBytes(24));
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash('sha256').update(verifier).digest());

const params = new URLSearchParams({
  client_id: savedClientId ?? 'dynamic_agent_client',
  response_type: 'code',
  redirect_uri: REDIRECT_URI,
  scope: SCOPE,
  resource: RESOURCE,
  state,
  nonce,
  code_challenge_method: 'S256',
  code_challenge: challenge,
  ext_agent_host_id: hostId,
});
if (!savedClientId) params.set('agent_name_hint', APP_NAME);
if (savedClientId && savedIdToken) params.set('id_token_hint', savedIdToken);

const authorizeUrl = `${AUTHORIZE_URL}?${params.toString()}`;

const pending = { resolve: null, reject: null };
const waitForCallback = new Promise((resolve, reject) => {
  pending.resolve = resolve;
  pending.reject = reject;
});

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:1455');
  if (url.pathname !== '/auth/callback') {
    res.writeHead(404).end();
    return;
  }
  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<script>document.title="auth failed";</script><h2>Вход не удался: ' + error + '</h2>');
    pending.reject(new Error(`callback error: ${error} ${url.searchParams.get('error_description') ?? ''}`));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<script>document.title="auth ok";</script><h2>Вход выполнен. Можно закрыть эту вкладку.</h2>');
  pending.resolve({
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    clientId: url.searchParams.get('client_id'),
    scope: url.searchParams.get('scope'),
  });
});

await new Promise((resolve) => server.listen(1455, '127.0.0.1', resolve));
console.log('listener ready on 127.0.0.1:1455, opening browser...');

console.log('authorize url:');
console.log(authorizeUrl);

const { spawn } = await import('node:child_process');
spawn('explorer', [authorizeUrl], { detached: true, stdio: 'ignore' }).unref();
console.log('browser launched via explorer. waiting for callback...');

let callback;
try {
  callback = await waitForCallback;
} finally {
  server.close();
}

if (callback.state !== state) throw new Error('state mismatch');

const issuedClientId = callback.clientId ?? savedClientId;
if (!issuedClientId || issuedClientId === 'dynamic_agent_client') {
  throw new Error('no issued client_id in callback');
}
console.log('issued client id:', issuedClientId);

const body = new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: issuedClientId,
  code: callback.code,
  code_verifier: verifier,
  redirect_uri: REDIRECT_URI,
  resource: RESOURCE,
});

const tokenRes = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: body.toString(),
});
if (!tokenRes.ok) {
  console.error('token exchange failed', tokenRes.status, (await tokenRes.text()).slice(0, 400));
  process.exit(1);
}
const tokens = await tokenRes.json();

function jwtPayload(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64url').toString('utf8'));
}

const idPayload = jwtPayload(tokens.id_token);
const grantedScopes = (tokens.scope ?? callback.scope ?? '').split(/[\s+]+/).filter(Boolean);

const creds = {
  email: idPayload.email ?? null,
  issuer: idPayload.iss,
  subject: idPayload.sub,
  client_id: issuedClientId,
  ext_agent_host_id: hostId,
  id_token: tokens.id_token,
  access_token: tokens.access_token,
  refresh_token: tokens.refresh_token,
  token_type: tokens.token_type,
  expires_in: tokens.expires_in,
  scopes: grantedScopes,
  saved_at: new Date().toISOString(),
};
atomicWrite(CREDS_FILE, JSON.stringify(creds, null, 2));

console.log('email:', creds.email);
console.log('scopes granted:', grantedScopes.join(' '));
console.log('has chatgpt.tokens.use.direct:', grantedScopes.includes('chatgpt.tokens.use.direct'));
console.log('access expires_in:', tokens.expires_in);
console.log('saved:', CREDS_FILE);
