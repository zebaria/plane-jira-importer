/**
 * Wrapper that copies `scripts/seed-members.py` and `data/users.json`
 * onto the Plane EC2 host via AWS SSM, then runs the Python script
 * inside the api container as a Django shell script.
 *
 * Why SSM: the Plane host has no public IP and no SSH; SSM is the
 * documented way in for ops. We use `aws ssm send-command` rather
 * than `start-session` so this script can run unattended.
 *
 * Usage:
 *   PLANE_INSTANCE_ID=i-0abcd... npm run scripts:seed-members
 *
 * Optional:
 *   USERS_FILE=data/users.json
 *   PLANE_WORKSPACE_SLUG=wz       (already in .env via the importer)
 *   AWS_REGION=us-east-1          (or read from your default profile)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv();

const INSTANCE_ID = process.env.PLANE_INSTANCE_ID;
const WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG;
const USERS_FILE = resolve(process.env.USERS_FILE ?? 'data/users.json');
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

if (!INSTANCE_ID || !WORKSPACE_SLUG) {
  console.error(
    'Missing PLANE_INSTANCE_ID or PLANE_WORKSPACE_SLUG. Both are required.\n' +
      'Get the instance id with: terraform output -raw host_instance_id (in your corpinfra dev workspace)',
  );
  process.exit(1);
}

const SCRIPT_PATH = resolve('scripts/seed-members.py');

// Read the two files we'll send to the host.
const usersJson = readFileSync(USERS_FILE, 'utf-8');
const seedScript = readFileSync(SCRIPT_PATH, 'utf-8');

/** Encode a string for safe `cat <<EOF` heredoc on the remote host. */
function b64(content: string): string {
  return Buffer.from(content, 'utf-8').toString('base64');
}

const remoteCommands = [
  // Stage files in /tmp on the host
  `echo '${b64(usersJson)}' | base64 -d > /tmp/users.json`,
  `echo '${b64(seedScript)}' | base64 -d > /tmp/seed-members.py`,
  // Copy into the api container
  'docker cp /tmp/users.json api:/tmp/users.json',
  'docker cp /tmp/seed-members.py api:/tmp/seed-members.py',
  // Execute. argv inside Django shell -c is passed through to the
  // module being exec'd, so we wrap the script in an exec() call and
  // splice argv in via sys.argv.
  `docker exec api python manage.py shell -c "import sys; sys.argv=['seed-members', '${WORKSPACE_SLUG}', '/tmp/users.json']; exec(open('/tmp/seed-members.py').read())"`,
  // Cleanup
  'rm -f /tmp/users.json /tmp/seed-members.py',
  'docker exec api rm -f /tmp/users.json /tmp/seed-members.py',
];

const ssmArgs = [
  'ssm',
  'send-command',
  '--instance-ids',
  INSTANCE_ID,
  '--document-name',
  'AWS-RunShellScript',
  '--parameters',
  JSON.stringify({ commands: remoteCommands }),
  '--query',
  'Command.CommandId',
  '--output',
  'text',
];
if (REGION) ssmArgs.push('--region', REGION);

console.log(`Sending seed-members run to ${INSTANCE_ID}…`);
const commandId = execFileSync('aws', ssmArgs, { encoding: 'utf-8' }).trim();
console.log(`SSM command id: ${commandId}`);

// Poll until the command finishes (≤2 min should be plenty for ~20 users).
const startedAt = Date.now();
const deadline = startedAt + 120_000;

const pollArgs = [
  'ssm',
  'list-command-invocations',
  '--command-id',
  commandId,
  '--instance-id',
  INSTANCE_ID,
  '--details',
  '--query',
  'CommandInvocations[0]',
  '--output',
  'json',
];
if (REGION) pollArgs.push('--region', REGION);

let inv: { Status: string; CommandPlugins: { Output: string }[] } | null = null;
while (Date.now() < deadline) {
  const out = execFileSync('aws', pollArgs, { encoding: 'utf-8' });
  inv = JSON.parse(out);
  if (
    inv &&
    !['Pending', 'InProgress', 'Delayed'].includes(inv.Status)
  ) {
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}

if (!inv) {
  console.error('No invocation visible — SSM agent reachable on the instance?');
  process.exit(1);
}

const stdout = inv.CommandPlugins?.[0]?.Output ?? '';
console.log('--- output ---');
console.log(stdout);
console.log(`--- status: ${inv.Status} ---`);

if (inv.Status !== 'Success') {
  process.exit(1);
}