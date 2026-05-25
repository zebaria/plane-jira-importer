/**
 * Create an APIToken for a Plane bot user via SSM. Pulls the printed
 * token out of the remote stdout and prints it locally. The secret is
 * displayed once and never retrievable again.
 *
 * Usage:
 *   PLANE_INSTANCE_ID=i-... \\
 *   BOT_EMAIL=selberg+wildzebot@wildzebra.com \\
 *   BOT_LABEL=vger-bot \\
 *   BOT_DESCRIPTION="vger / vibegrunt service token" \\
 *   npm run scripts:create-bot-token
 *
 * Optional: PLANE_WORKSPACE_SLUG (defaults to .env), AWS_REGION.
 *
 * Idempotent: if a token with the same `label` already exists for
 * `BOT_EMAIL`, the remote script prints "exists" and exits 0; we
 * propagate that and don't print a secret. To rotate, delete the
 * APIToken row in the DB first (or use a new label).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv();

const INSTANCE_ID = process.env.PLANE_INSTANCE_ID;
const WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG;
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const BOT_EMAIL = process.env.BOT_EMAIL;
const BOT_LABEL = process.env.BOT_LABEL;
const BOT_DESCRIPTION = process.env.BOT_DESCRIPTION ?? '';

if (!INSTANCE_ID || !WORKSPACE_SLUG || !BOT_EMAIL || !BOT_LABEL) {
  console.error(
    'Missing one of: PLANE_INSTANCE_ID, PLANE_WORKSPACE_SLUG, BOT_EMAIL, BOT_LABEL.\n' +
      'Get the instance id with: terraform output -raw host_instance_id',
  );
  process.exit(1);
}

const SCRIPT_PATH = resolve('scripts/create-bot-token.py');
const remoteScript = readFileSync(SCRIPT_PATH, 'utf-8');

function b64(content: string): string {
  return Buffer.from(content, 'utf-8').toString('base64');
}

// Stage argv as a JSON file rather than interpolating into a `python
// -c` string. Quote-injection from values containing apostrophes
// (think names like O'Brien, descriptions with code samples) would
// otherwise either break the python parse or worse, smuggle in
// unintended Python code.
const argv = [
  'create-bot-token',
  BOT_EMAIL,
  WORKSPACE_SLUG,
  BOT_LABEL,
  ...(BOT_DESCRIPTION ? [BOT_DESCRIPTION] : []),
];

const remoteCommands = [
  `echo '${b64(remoteScript)}' | base64 -d > /tmp/create-bot-token.py`,
  `echo '${b64(JSON.stringify(argv))}' | base64 -d > /tmp/create-bot-token.argv.json`,
  'docker cp /tmp/create-bot-token.py plane-api-1:/tmp/create-bot-token.py',
  'docker cp /tmp/create-bot-token.argv.json plane-api-1:/tmp/create-bot-token.argv.json',
  `docker exec plane-api-1 python manage.py shell -c "import sys, json; sys.argv = json.load(open('/tmp/create-bot-token.argv.json')); exec(open('/tmp/create-bot-token.py').read())"`,
  // Cleanup (don't keep secrets/scripts on disk; the token is in
  // the DB and printed to our stdout).
  'rm -f /tmp/create-bot-token.py /tmp/create-bot-token.argv.json',
  'docker exec plane-api-1 rm -f /tmp/create-bot-token.py /tmp/create-bot-token.argv.json',
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

console.log(`Creating bot token on ${INSTANCE_ID}…`);
const commandId = execFileSync('aws', ssmArgs, { encoding: 'utf-8' }).trim();
console.log(`SSM command id: ${commandId}`);

const deadline = Date.now() + 90_000;
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
    if (inv && !['Pending', 'InProgress', 'Delayed'].includes(inv.Status)) {
      break;
    }
  } catch (err) {
    consecutiveErrors++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  poll error (${consecutiveErrors}/3): ${msg.split('\n')[0]}`);
    if (consecutiveErrors >= 3) {
      console.error('Three consecutive poll failures — giving up.');
      process.exit(1);
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
}

if (!inv) {
  console.error('No invocation visible — SSM agent reachable on the instance?');
  process.exit(1);
}

const stdout = inv.CommandPlugins?.[0]?.Output ?? '';
console.log('--- output ---');
console.log(stdout);
console.log(`--- status: ${inv.Status} ---`);

if (inv.Status !== 'Success') process.exit(1);

const tokenLine = stdout.split('\n').find((l) => l.startsWith('BOT_TOKEN='));
if (tokenLine) {
  const token = tokenLine.slice('BOT_TOKEN='.length).trim();
  console.log();
  console.log('🔑  New bot token (save it now — secret is unrecoverable):');
  console.log(`    ${token}`);
} else if (stdout.includes('exists:')) {
  console.log();
  console.log('Token with that label already exists — see line above for id.');
  console.log('Delete the row and re-run to rotate, or use a new BOT_LABEL.');
}