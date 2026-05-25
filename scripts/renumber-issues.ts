/**
 * Wrapper that copies `scripts/renumber-issues.py` onto the Plane EC2
 * host via SSM and runs it inside the api container.
 *
 * Usage (env-driven, mirrors seed-members.ts):
 *
 *   PLANE_INSTANCE_ID=i-... \
 *   PLANE_WORKSPACE_SLUG=wz \
 *   PLANE_PROJECT_ID=<uuid> \
 *   AWS_REGION=us-east-1 \
 *   npm run scripts:renumber-issues
 *
 * Optional: DRY_RUN=1 prints the plan without writing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv();

const INSTANCE_ID = process.env.PLANE_INSTANCE_ID;
const WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG;
const PROJECT_ID = process.env.PLANE_PROJECT_ID;
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

if (!INSTANCE_ID || !WORKSPACE_SLUG || !PROJECT_ID) {
  console.error(
    'Missing one of: PLANE_INSTANCE_ID, PLANE_WORKSPACE_SLUG, PLANE_PROJECT_ID',
  );
  process.exit(1);
}

const SCRIPT_PATH = resolve('scripts/renumber-issues.py');
const remoteScript = readFileSync(SCRIPT_PATH, 'utf-8');
const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

// Stage argv as a JSON file rather than interpolating into a `python
// -c` string. Workspace slugs / project ids that contain quotes
// would otherwise break the Python parse or smuggle in unintended
// code. Same pattern as scripts/create-bot-token.ts.
const argv = ['renumber-issues', WORKSPACE_SLUG, PROJECT_ID];
if (DRY_RUN) argv.push('--dry-run');

const remoteCommands = [
  `echo '${b64(remoteScript)}' | base64 -d > /tmp/renumber-issues.py`,
  `echo '${b64(JSON.stringify(argv))}' | base64 -d > /tmp/renumber-issues.argv.json`,
  'docker cp /tmp/renumber-issues.py plane-api-1:/tmp/renumber-issues.py',
  'docker cp /tmp/renumber-issues.argv.json plane-api-1:/tmp/renumber-issues.argv.json',
  `docker exec plane-api-1 python manage.py shell -c "import sys, json; sys.argv = json.load(open('/tmp/renumber-issues.argv.json')); exec(open('/tmp/renumber-issues.py').read())"`,
  'rm -f /tmp/renumber-issues.py /tmp/renumber-issues.argv.json',
  'docker exec plane-api-1 rm -f /tmp/renumber-issues.py /tmp/renumber-issues.argv.json',
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

console.log(`Renumbering Plane issues on ${INSTANCE_ID}…`);
const commandId = execFileSync('aws', ssmArgs, { encoding: 'utf-8' }).trim();
console.log(`SSM command id: ${commandId}`);

// Plane has 1199 issues and the script does two passes — give it ~10
// min headroom for slow API container startup + rate-limited writes.
const deadline = Date.now() + 600_000;
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
let consecutiveErrors = 0;
while (Date.now() < deadline) {
  try {
    const out = execFileSync('aws', pollArgs, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    inv = JSON.parse(out);
    consecutiveErrors = 0;
    if (inv && !['Pending', 'InProgress', 'Delayed'].includes(inv.Status)) break;
  } catch (err) {
    consecutiveErrors++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  poll error (${consecutiveErrors}/3): ${msg.split('\n')[0]}`);
    if (consecutiveErrors >= 3) {
      console.error('Three consecutive poll failures — giving up.');
      process.exit(1);
    }
  }
  await new Promise((r) => setTimeout(r, 5000));
}

if (!inv) {
  console.error('No invocation visible.');
  process.exit(1);
}

const stdout = inv.CommandPlugins?.[0]?.Output ?? '';
console.log('--- output ---');
console.log(stdout);
console.log(`--- status: ${inv.Status} ---`);

if (inv.Status !== 'Success') process.exit(1);