import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2];
assert(['start', 'status', 'stop', 'doctor'].includes(action), 'Use start, status, stop or doctor');
const binary = resolve(root, '.local-tools/tunnel-client/tunnel-client.exe');
assert(existsSync(binary), 'Install the official tunnel-client in .local-tools/tunnel-client');
const config = JSON.parse(readFileSync(resolve(root, '.local-tools/tunnel-connection.json'), 'utf8'));
assert(/^tunnel_[a-z0-9]+$/.test(config.tunnelId), 'Invalid tunnel ID');
const profileDir = resolve(root, '.local-tools/tunnel-profile');
const envFile = resolve(root, '.local-tools/tunnel.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const slash = path => path.replaceAll('\\', '/');
const command = `"${slash(process.execPath)}" --import "${pathToFileURL(resolve(root, 'node_modules/tsx/dist/loader.mjs')).href}" "${slash(resolve(root, 'server/stdio.ts'))}"`;
const args = action === 'start'
  ? ['runtimes', 'connect', '--alias', 'vetvi-local', '--tunnel-id', config.tunnelId, '--profile', 'vetvi-local', '--profile-dir', profileDir, '--runtime-api-key', 'env:CONTROL_PLANE_API_KEY', '--mcp-command', command, '--json']
  : action === 'doctor'
    ? ['doctor', '--profile', 'vetvi-local', '--profile-dir', profileDir, '--explain']
    : ['runtimes', action, 'vetvi-local', '--json'];
if (action === 'start' || action === 'doctor') assert(process.env.CONTROL_PLANE_API_KEY, 'Missing CONTROL_PLANE_API_KEY in .local-tools/tunnel.env');
const result = spawnSync(binary, args, { env: process.env, cwd: root, encoding: 'utf8', windowsHide: true });
if (action === 'doctor') process.stdout.write(result.stdout || 'No diagnostic output\n');
else {
  try {
    const value = JSON.parse(result.stdout);
    console.log(JSON.stringify({ action, tunnelId: config.tunnelId, process_running: value.process_running, healthy: value.healthy, ready: value.ready, ui_url: value.ui_url, error: value.remote_error || value.error || undefined }, null, 2));
  } catch { console.error(`Tunnel command failed: ${result.error?.message || `exit ${result.status}`}`); }
}
process.exitCode = result.status ?? 1;
