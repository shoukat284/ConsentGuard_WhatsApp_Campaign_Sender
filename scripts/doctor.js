'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const required = ['package.json', 'package-lock.json', 'main.js', 'preload.js'];
let failed = false;

function line(label, value, ok = true) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${value}`);
  if (!ok) failed = true;
}

function supportedNode(version) {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  const [major, minor] = parts;
  return (major === 22 && minor >= 12) || major === 24;
}

function supportedNpm(version) {
  const major = Number(String(version).split('.')[0]);
  return major === 10 || major === 11;
}

line('Node.js', process.version, supportedNode(process.version));

let npmVersion = 'unavailable';
try {
  npmVersion = execSync('npm --version', { encoding: 'utf8' }).trim();
} catch (_) {}
line('npm', npmVersion, supportedNpm(npmVersion));

for (const file of required) {
  line(file, path.join(root, file), fs.existsSync(path.join(root, file)));
}

let registry = 'unavailable';
try {
  registry = execSync('npm config get registry', { encoding: 'utf8' }).trim();
} catch (_) {}
console.log(`INFO npm active registry: ${registry}`);

const npmrcPath = path.join(root, '.npmrc');
const npmrc = fs.existsSync(npmrcPath) ? fs.readFileSync(npmrcPath, 'utf8') : '';
line('project registry policy', 'registry.npmjs.org', /registry=https:\/\/registry\.npmjs\.org\/?/.test(npmrc));

const lockPath = path.join(root, 'package-lock.json');
const lockText = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : '';
line('lockfile registry URLs', 'public npm registry', !/packages\.applied-caas|artifactory\/api\/npm/i.test(lockText));

const modules = ['electron', 'node-cron'];
for (const mod of modules) {
  try {
    require.resolve(mod, { paths: [root] });
    line(`module ${mod}`, 'installed', true);
  } catch (_) {
    line(`module ${mod}`, 'not installed', false);
  }
}

if (failed) {
  console.error('\nEnvironment check failed. Run INSTALL_WINDOWS.cmd from the project folder.');
  process.exitCode = 1;
} else {
  console.log('\nEnvironment check passed.');
}
