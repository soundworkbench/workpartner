import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureDirectory = path.join(root, 'tools/k8s/fixtures/live-gateway');
const tool = path.join(root, 'tools/k8s/live-diff.mjs');

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-live-diff-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.copyFileSync(path.join(fixtureDirectory, 'organization.json'), path.join(directory, 'organization.json'));
  fs.copyFileSync(path.join(fixtureDirectory, 'deployment.json'), path.join(directory, 'deployment.json'));
  fs.copyFileSync(path.join(fixtureDirectory, 'secret-keys.json'), path.join(directory, 'secret-keys.json'));
  return {
    directory,
    deployment: path.join(directory, 'deployment.json'),
    organization: path.join(directory, 'organization.json'),
    secrets: path.join(directory, 'secret-keys.json'),
  };
}

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function run(args, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workpartner-live-diff-cli-'));
  const stdoutPath = path.join(directory, 'stdout');
  const stderrPath = path.join(directory, 'stderr');
  const stdout = fs.openSync(stdoutPath, 'w');
  const stderr = fs.openSync(stderrPath, 'w');
  let input;
  try {
    const inputPath = path.join(directory, 'stdin');
    if (options.input !== undefined) {
      fs.writeFileSync(inputPath, options.input);
      input = fs.openSync(inputPath, 'r');
    }
    const result = spawnSync(process.execPath, [tool, ...args], {
      env: { PATH: process.env.PATH }, stdio: [input ?? 'ignore', stdout, stderr],
    });
    assert.ifError(result.error);
    return {
      ...result,
      stdout: fs.readFileSync(stdoutPath, 'utf8'),
      stderr: fs.readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    fs.closeSync(stdout); fs.closeSync(stderr); if (input !== undefined) fs.closeSync(input);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
function baseArgs(fixture, ...extra) {
  return ['--org', fixture.directory, '--live', fixture.deployment, ...extra];
}
function addReadiness(deployment) {
  deployment.spec.template.spec.containers[0].readinessProbe = { tcpSocket: { port: 'gateway' }, periodSeconds: 2 };
}

test('live snapshot differs only by the repository readiness probe', t => {
  const fixture = setup(t);
  const result = run(baseArgs(fixture, '--secret-keys', fixture.secrets));
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'spec.template.spec.containers[0].readinessProbe: live=<absent> rendered={"tcpSocket":{"port":"gateway"},"periodSeconds":2}',
  ]);
});

test('adding the readiness probe makes the sanitized live snapshot equal', t => {
  const fixture = setup(t);
  const deployment = read(fixture.deployment);
  addReadiness(deployment);
  write(fixture.deployment, deployment);
  const result = run(baseArgs(fixture, '--secret-keys', fixture.secrets));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('hostPath, resource and Secret expansion drift is reported', t => {
  const fixture = setup(t);
  const organization = read(fixture.organization);
  delete organization.runtime.k8s.deploy.hostPaths.sharedSkills;
  write(fixture.organization, organization);
  let result = run(baseArgs(fixture, '--secret-keys', fixture.secrets));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /shared-skills/);
  assert.match(result.stdout, /persistentVolumeClaim/);

  const withResources = setup(t);
  const resourceOrganization = read(withResources.organization);
  delete resourceOrganization.runtime.k8s.gatewayResources;
  write(withResources.organization, resourceOrganization);
  result = run(baseArgs(withResources, '--secret-keys', withResources.secrets));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /resources\.(limits|requests)\.memory: live="1Gi" rendered="512Mi"/);

  const withoutSecretKeys = setup(t);
  result = run(baseArgs(withoutSecretKeys));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\.envFrom/);
  assert.match(result.stdout, /\.env\[/);
});

test('extra live environment variables and ignored server fields are handled', t => {
  const fixture = setup(t);
  const deployment = read(fixture.deployment);
  addReadiness(deployment);
  deployment.metadata.resourceVersion = 'changed';
  deployment.status = { availableReplicas: 1 };
  deployment.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = 'changed';
  deployment.spec.template.spec.containers[0].env.push({ name: 'TREG_EXTRA', value: 'present' });
  write(fixture.deployment, deployment);
  let result = run(baseArgs(fixture, '--secret-keys', fixture.secrets));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /TREG_EXTRA/);

  const imageDeployment = read(fixture.deployment);
  imageDeployment.spec.template.spec.containers[0].env = imageDeployment.spec.template.spec.containers[0].env
    .filter(entry => entry.name !== 'TREG_EXTRA');
  imageDeployment.spec.template.spec.containers[0].image = 'example-gateway:changed';
  write(fixture.deployment, imageDeployment);
  result = run(baseArgs(fixture, '--secret-keys', fixture.secrets));
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /image/);
  result = run(baseArgs(fixture, '--secret-keys', fixture.secrets, '--compare-image'));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\.image: live="example-gateway:changed"/);
});

test('JSON output and stdin input follow the CLI contract', t => {
  const fixture = setup(t);
  const result = run(['--org', fixture.directory, '--live', '-', '--secret-keys', fixture.secrets, '--json'], {
    input: fs.readFileSync(fixture.deployment),
  });
  assert.equal(result.status, 1);
  const differences = JSON.parse(result.stdout);
  assert.equal(differences.length, 1);
  assert.equal(differences[0].path, 'spec.template.spec.containers[0].readinessProbe');
  assert.equal(differences[0].live, null);
});
