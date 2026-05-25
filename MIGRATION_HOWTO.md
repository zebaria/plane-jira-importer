# Migration howto

End-to-end recipe for migrating a Jira Cloud project to a self-hosted
Plane Community Edition instance — the way we did it at zebaria
(1,199 issues, 725 sprint assignments, 257 inline images, 9 active
employees pre-seeded, 7 former employees as pending invites). Wear
the same path tomorrow and you should land in the same place.

This guide covers what the upstream `plane-jira-importer` doesn't
do alone: the surrounding scripts in `scripts/` for prepping users
and states, seeding workspace members directly into the Plane DB
(necessary for CE because the public API has no admin-create-user
path), creating a service-account API token, sprint→module
translation, sequence-id renumbering so Plane's `WZ-N` keys match
Jira's, and rewriting inline image markup from `<img>` to Plane's
TipTap-native `<image-component>`.

If you only need the basic importer (issues, comments, attachments,
no sprints, no member seeding), the README is enough. This guide is
for "the migration produced an internal tracker that actually feels
like Jira did."

---

## What you'll need before starting

**Jira:**
- API token from <https://id.atlassian.com/manage-profile/security/api-tokens>
- Project key (e.g. `WZ`)
- The numeric custom-field id for "Sprint" (default `customfield_10020`
  on most company-managed projects)

**Plane:**
- Self-hosted instance, version 1.3.x or compatible
- A workspace already created
- A target project with the desired identifier (the migrator doesn't
  create projects)
- A **personal API token** for bootstrapping (avatar → Settings →
  API tokens). The bot's token gets created mid-flow; we keep both
  in `.env` and the scripts pick the right one per step.
- Server-side env vars set on the Plane API container:
  - `FILE_SIZE_LIMIT=262144000` (250 MB) — Plane's default 5 MB
    silently caps S3 presigned URLs and any larger attachment fails
    with `EntityTooLarge`. See "Pitfalls" below.
  - `API_KEY_RATE_LIMIT=600/minute` — default is 60/min which the
    importer hits in seconds.
  - Both `cycle_view` and `module_view` enabled on the target
    project (the sprint script will flip these on for you).

**Local:**
- Node.js 22, plus `tsx` (this repo uses it for `node --import tsx`)
- AWS CLI configured with permission to send SSM commands to the
  Plane EC2 host (used for the seed-members and create-bot-token
  scripts, which run Django shell commands via SSM)

---

## The flow at a glance

```
Pull Jira users        →  data/users.json   (hand-edit)
  ↓
Pull Jira state names  →  data/state-mapping.json
  ↓
Send Plane invitations to all users
  ↓
Seed current employees as Plane workspace members (Django shell, via SSM)
  ↓
Create the bot's APIToken row (Django shell, via SSM)
  ↓
Add the bot's token to .env as PLANE_BOT_API_KEY
  ↓
Add bot + everyone else to the target Plane project
  ↓
Run the importer:  --users-file --state-mapping-file
  ↓
Renumber Plane issues so the displayed key matches Jira's
  ↓
Migrate sprints → modules
  ↓
Rewrite Jira <img> URLs in descriptions → Plane <image-component>
```

The scripts use two different `PLANE_API_KEY` roles in `.env`:

```ini
PLANE_PERSONAL_API_KEY=plane_api_<personal>   # bootstrap scripts
PLANE_BOT_API_KEY=plane_api_<bot>             # importer + post-passes
```

Each script picks the right one automatically based on what it does.
You can also set just `PLANE_API_KEY=...` as a fallback if you don't
care about distinguishing — both roles will use it.

---

## Step-by-step

### 0. Configure `.env`

```ini
JIRA_HOST=your-tenant.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=ATATT3xFf...

PLANE_HOST=https://plane.example.com
PLANE_WORKSPACE_SLUG=wz
PLANE_PROJECT_ID=<uuid>

# Bootstrap scripts (users, invites, seed-members, create-bot-token)
# use this token. Authorise with your own identity.
PLANE_PERSONAL_API_KEY=plane_api_<personal>

# Importer + post-passes (renumber, sprints, image rewrite) use this.
# Created via scripts:create-bot-token in step 5 — paste it here
# afterward.
# PLANE_BOT_API_KEY=plane_api_<bot>
```

The scripts auto-pick the right token by role. Either fill in both
or fall back to a single `PLANE_API_KEY=...` if you don't care to
distinguish.

### 1. Pull Jira users

```bash
PROJECT_KEY=WZ npm run scripts:users
```

Walks every issue in the source project and writes
`data/users.json` — a map of `jira_account_id → { display_name,
email, current, _seen_in[] }`. Jira's GDPR-mode API hides emails for
everyone except the authenticated user, so you'll need to fill them
in by hand:

```json
{
  "712020:abc...": {
    "display_name": "Alice Example",
    "email": "alice@example.com",
    "current": true,
    "_seen_in": ["assignee", "reporter"]
  },
  ...
}
```

Set `current: false` for former employees. The importer will still
note them in the migrated description ("Originally assigned to:
Alice Example <alice@example.com>") so the historical record stays
intact, but won't try to assign their Plane work items (since they
won't be Plane members).

Re-running the script merges new accounts without clobbering edits.

### 2. Pull state mapping

```bash
PROJECT_KEY=WZ PLANE_PROJECT_ID=<uuid> npm run scripts:states
```

Writes `data/state-mapping.json` — Jira status name → Plane state
name. Auto-matches by case+space-normalized name. Anything left as
`null` is unmapped and you must either rename a state in Plane or
edit the file. If your Jira project uses a custom workflow state
that doesn't exist in Plane (we had `priority`), create it directly
via API:

```bash
curl -s -H "X-API-Key: $PLANE_API_KEY" -H "Content-Type: application/json" \
  -X POST "$PLANE_HOST/api/v1/workspaces/$WS/projects/$PID/states/" \
  -d '{"name":"Priority","color":"#f59e0b","group":"started",
       "description":"High-priority active work"}'
```

…then re-run `scripts:states` so the mapping picks up the new state.

### 3. Send Plane invitations

```bash
npm run scripts:invite
```

Reads `data/users.json` (de-duplicated by email — multiple Jira
accountIds for the same person collapse), POSTs Plane workspace
invitations for all unique emails. Plane sends the standard "you've
been invited" email via the SMTP we configured in god-mode.

Idempotent — already-invited or already-member emails are skipped.

### 4. Seed current employees as Plane members (via SSM)

Plane CE has no admin API to create a workspace member without an
interactive sign-in. We work around that by running a Django shell
command inside the api container directly:

```bash
PLANE_INSTANCE_ID=i-0abc...   \
  AWS_REGION=us-east-1        \
  npm run scripts:seed-members
```

The script:
- Creates `User` rows (random unguessable password, marked
  `is_email_verified=true`)
- Creates `Profile` rows
- Creates `WorkspaceMember` rows with role 15 (Member)
- Deletes the now-redundant `WorkspaceMemberInvite` rows

Verified safe against
`apps/api/plane/authentication/adapter/base.py` in upstream preview:
`complete_login_or_signup` matches by email first, so when these
users later sign in via Google OAuth, Plane reuses the seeded row
rather than creating a duplicate.

Output:
```
created=9 existed=3 skipped(former-or-no-email)=8 invites-dropped=9
```

The `existed` count comes from duplicate Jira accountIds (e.g. two
rows for the same person from a pre-2018 Atlassian merge) collapsing
to one Plane User row.

### 5. Mint a service-account API token

Same SSM pattern. Pick an email for the bot (we used
`selberg+wildzebot@wildzebra.com` — gmail's plus addressing means
it lands in the human's inbox).

```bash
PLANE_INSTANCE_ID=i-0abc...   \
  AWS_REGION=us-east-1        \
  PLANE_WORKSPACE_SLUG=wz     \
  BOT_EMAIL=selberg+wildzebot@wildzebra.com \
  BOT_LABEL=wildzebot-default \
  BOT_DESCRIPTION="Default service token" \
  npm run scripts:create-bot-token
```

Token is printed once on stdout. **Save it.** Then add it to `.env`:

```ini
PLANE_BOT_API_KEY=plane_api_<bot-token>
```

The remaining steps (importer, renumber, sprints, image rewrite)
read `PLANE_BOT_API_KEY` automatically.

### 6. Add the bot + everyone else to the target Plane project

Plane has separate workspace-vs-project membership. Workspace members
aren't automatically project members, and the importer needs to be a
project member to write issues there.

```bash
SLUG=wz; PID=<plane-project-uuid>

curl -s -H "X-API-Key: $PLANE_API_KEY" "$PLANE_HOST/api/v1/workspaces/$SLUG/members/" \
  | python3 -c "
import sys, json, urllib.request
ws = json.load(sys.stdin)
req = urllib.request.Request(
    f'$PLANE_HOST/api/v1/workspaces/$SLUG/projects/$PID/members/',
    headers={'X-API-Key': '$PLANE_API_KEY'})
proj_ids = {m['id'] for m in json.loads(urllib.request.urlopen(req).read())}
for m in ws:
    if m['id'] not in proj_ids:
        print(m['id'], m['email'])" \
  | while IFS=' ' read -r uid email; do
      curl -s -H "X-API-Key: $PLANE_API_KEY" -H "Content-Type: application/json" \
        -X POST "$PLANE_HOST/api/v1/workspaces/$SLUG/projects/$PID/members/" \
        -d "{\"member\":\"$uid\",\"role\":15}" > /dev/null
      echo "added $email"
    done
```

The `member` field expects the User UUID, not the WorkspaceMember
UUID — these are different rows.

### 7. Run the importer

```bash
PLANE_RATE_LIMIT=300 JIRA_RATE_LIMIT=300 MAX_ATTACHMENT_SIZE_MB=250 \
  npm start -- \
  --project-key WZ \
  --plane-project <uuid> \
  --users-file data/users.json \
  --state-mapping-file data/state-mapping.json
```

Fully non-interactive when both files are passed. The importer:
- Walks Jira issues via cursor pagination (Jira deprecated `startAt`
  on `/search/jql` in May 2024)
- Maps assignees by email; for unmatched users, prepends an
  "Originally assigned to: Name <email>" line to the description
- Squashes reporter into the same description note (Plane API forces
  `created_by` to the API key owner)
- Creates Plane work items, comments, attachments
- On HTTP 409 (FileAsset row exists from a previous failed S3
  upload), deletes the orphan and retries — see "Pitfalls"

Re-runs are idempotent (`external_id`-keyed). For non-interactive
re-runs, the script defaults to "skip existing"; pass `--reimport`
to update.

### 8. Renumber Plane issues to match Jira keys

Plane assigns its own `sequence_id` at insert time (1, 2, 3, ...).
A migration that imports 1,199 issues from a project numbered up to
WZ-1258 ends up with Plane keys 1..1199 — and the issue Jira called
WZ-1117 becomes Plane WZ-1180 in the URL/UI.

```bash
PLANE_INSTANCE_ID=i-0abc... \
  AWS_REGION=us-east-1 \
  PLANE_WORKSPACE_SLUG=wz \
  PLANE_PROJECT_ID=<uuid> \
  npm run scripts:renumber-issues
```

Reads each Plane issue's `external_id` (set to `WZ-1117` etc. by the
importer), parses the integer suffix, and updates both
`Issue.sequence_id` and the matching `IssueSequence.sequence`. Two
phases under a transaction: park every row in a temp range above
the current max, then set each to its target.

Add `DRY_RUN=1` to print the plan without writing.

After this step, Plane URLs match Jira URLs by ticket number, and
new Plane issues created post-migration will start at
`<max-existing> + 1` — preserving the gaps from any deleted Jira
tickets.

### 9. Migrate sprints → modules

```bash
npm run scripts:sprints -- \
  --project-key WZ \
  --plane-project <uuid>
```

Mapping rule (a Plane Cycle is the equivalent of an active Jira
Sprint, but Plane refuses writes on completed cycles, so closed
Jira sprints have to become Modules):

- `endDate` in the FUTURE → Plane Cycle (status auto-tracks via
  date)
- `endDate` in the PAST or no dates → Plane Module
  (`status=completed` if past end_date, `planned` otherwise)

Pulls all sprints from the agile board (`/rest/agile/1.0/board/{id}/sprint`)
so empty buckets ("WZ 26 EOY" with no issues) get migrated too.

Each issue gets assigned to its most-recent sprint's
module/cycle. Issues that carried over multiple sprints land in the
latest one (sorted by endDate DESC, then sprint id DESC as tiebreaker).

### 10. Rewrite inline image markup

The upstream importer copies Jira's rendered description HTML
verbatim, so inline images keep their Jira-hosted URLs:

```html
<img src="https://your-tenant.atlassian.net/rest/api/3/attachment/content/14937" alt="...">
```

Browser users have no Jira session, so these images fail to load.

Plane's TipTap editor parses `<image-component>` (a custom node),
not plain `<img>`. The component's `src` is the Plane asset UUID;
the editor's `getAssetSrc` callback resolves it to a real URL at
render time. Verified against
`packages/editor/src/core/extensions/custom-image/extension-config.ts`
in upstream preview.

```bash
npm run scripts:rewrite-image-urls -- \
  --plane-project <uuid>
```

Walks every work item, finds Jira-hosted `<img>` tags in the
description, looks up the matching Plane attachment by
`external_id` (= Jira attachment numeric id), and replaces the tag
with `<image-component id="<asset>" src="<asset>" status="uploaded"
alignment="left" width="35%" height="auto">`.

Throttled at ~5 req/sec to stay under `API_KEY_RATE_LIMIT=600/min`.
Idempotent — descriptions without `atlassian.net` URLs are skipped.

---

## Pitfalls we hit (so you don't have to)

### 1. `EntityTooLarge` on attachment uploads

Plane's `FILE_SIZE_LIMIT` (env var on the api container, default
**5 MB**) silently caps the S3 presigned URL's `content-length-range`
at `min(client_size, FILE_SIZE_LIMIT)`. Any larger attachment fails
with HTTP 400 from S3 mid-upload, not from Plane up front. The
importer's own `MAX_ATTACHMENT_SIZE_MB=100` default masks the
mismatch — you find out per-attachment, after the upload, with no
actionable error.

**Fix:** set `FILE_SIZE_LIMIT=262144000` (250 MB) on the api
container, recreate, then re-run with
`MAX_ATTACHMENT_SIZE_MB=250`.

The importer probes `/api/instances/` at startup and warns if the
server cap is smaller than the client cap — but only via a log line.
Watch for it.

### 2. HTTP 409 conflict on attachment re-upload

If a previous run created the FileAsset row but the S3 PUT failed
(see #1), the row is orphaned with `is_uploaded=false`. A re-run
gets HTTP 409 from POST `/attachments/` with the existing asset id.
Plane has no resume API for an orphaned asset.

**Fix in this fork:** the importer catches 409, parses the orphan
id from the error body, deletes it via DELETE, and re-POSTs cleanly.
Logs an "Orphaned attachment row for X — deleting and retrying"
line per recovery.

### 3. API throttling

Plane's default `API_KEY_RATE_LIMIT` is `60/minute`, which the
importer blows through in seconds. Even at the importer's own
`PLANE_RATE_LIMIT=60` default, walking 1,199 issues + creating
attachments + comments will hit the cap repeatedly.

**Fix:** raise `API_KEY_RATE_LIMIT` server-side (we use
`600/minute`) and pass `PLANE_RATE_LIMIT=300` to the importer.

### 4. Closed cycles are read-only

Plane refuses both `cycle-issues` POST and `cycle` PATCH on cycles
whose `end_date` has passed. There's no "reopen" or "force admin"
path. Any sprint that's already closed must be a Module, not a
Cycle. The sprint migrator implements that rule; if you have legacy
closed cycles from an earlier run, pass `--delete-orphan-cycles` to
clean them up.

### 5. Image markup needs `<image-component>` not `<img>`

If you hand-PATCH a description with `<img src="...">` pointing at
a Plane asset URL, the editor silently drops the tag (it parses
`image-component`, not `img`). Use the rewrite script.

### 6. Workspace member ≠ project member

A user can be in the workspace but not in a target project. The
importer will get HTTP 403 if the API key owner isn't a project
member. Step 6 above adds the bot (and everyone else) to the
target project explicitly.

### 7. `data/users.json` and email-deduplication

If two Jira accountIds resolve to the same email (pre-2018 Atlassian
account merger leftover, or someone who left and came back), the
seed-members script collapses them to one Plane User row. The
importer correctly assigns either Jira accountId to the same Plane
member. No manual cleanup needed.

### 8. The bot account itself

If you want comments and assignments to attribute to a generic
"Imported by bot" identity (rather than your personal account), seed
the bot before step 5 and use its API key for the rest of the flow.
Plane's API forces `created_by` to be the token owner — there's no
way to attribute migrated comments to the original Jira author at
the API level. The importer prefixes the comment body with the
original author's name so the human attribution survives in text,
even though the row says the bot wrote it.

---

## Verification checklist after migration

- [ ] Plane work item count = Jira issue count for the project
- [ ] Open a few migrated issues and confirm description, comments,
  attachments, labels, priority, status, assignee
- [ ] Confirm renumbered Plane key matches the Jira key
  (`WZ-1117` displays as `WZ-1117`, not `WZ-1180`)
- [ ] Confirm inline images render (browser → migrated issue with a
  screenshot)
- [ ] Sprints visible under Modules in the project; issues correctly
  assigned to their last sprint
- [ ] Verify a current-employee user signing in via your OAuth
  provider lands on their pre-seeded account (not a duplicate)

---

## Cleanup

After the migration is verified:
- Drop the `data-prod/` (or per-env) folder if you don't want emails
  in the working tree
- Rotate the personal Plane token (the bot's stays — that's the
  service account)
- Disable the Jira Cloud account if you're decommissioning Jira
- Keep `data/users.json` and `data/state-mapping.json` (no secrets,
  small, useful for re-runs / debugging)

---

## When NOT to use this guide

- **Jira Server / Data Center**: the API endpoints in this importer
  target Jira Cloud REST v3. Server has different paths.
- **Migrating to Plane Cloud**: their managed importer (paid tier)
  handles a lot more (workflows, custom fields, etc.). This guide is
  for self-hosted CE, where the paid importers aren't available.
- **Projects with attachments > 250 MB**: bump `FILE_SIZE_LIMIT`
  and `MAX_ATTACHMENT_SIZE_MB` in lockstep, but watch RDS storage
  and CloudWatch ingest cost.