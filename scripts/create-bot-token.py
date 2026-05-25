"""
Create an APIToken for an existing Plane User, marked as user_type=1
(Bot). Use for service accounts that need API access without an
interactive sign-in — e.g. a `you+bot@example.com` plus-addressed
user that you seeded but locked out of password / OAuth login.

Runs inside the api container as a Django shell script:

    docker exec plane-api-1 python manage.py shell -c \\
        "exec(open('/tmp/create-bot-token.py').read())" \\
        <user-email> <workspace-slug> <label> [description]

The token is printed once at the end. Capture it from stdout — it is
not retrievable later because the column is hashed-on-read by Plane's
auth middleware.

Idempotent semantics: if a token with the same `label` already exists
for the user, the script prints "exists" and the existing token's UUID
(NOT the secret), and exits 0. To rotate, delete the row first.
"""

import sys

from plane.db.models import APIToken, User, Workspace

if len(sys.argv) < 4:
    print(
        "usage: create-bot-token.py <user-email> <workspace-slug> "
        "<label> [description]",
        file=sys.stderr,
    )
    sys.exit(1)

email = sys.argv[1].lower().strip()
slug = sys.argv[2]
label = sys.argv[3]
description = sys.argv[4] if len(sys.argv) > 4 else ""

user = User.objects.filter(email=email).first()
if not user:
    print(f"no user with email {email!r}", file=sys.stderr)
    sys.exit(1)

ws = Workspace.objects.filter(slug=slug).first()
if not ws:
    print(f"no workspace with slug {slug!r}", file=sys.stderr)
    sys.exit(1)

existing = APIToken.objects.filter(user=user, label=label).first()
if existing:
    print(
        f"exists: label={label!r} token_id={existing.id} created_at={existing.created_at}"
    )
    print("(secret is unrecoverable; delete and re-run to rotate)")
    sys.exit(0)

token = APIToken.objects.create(
    user=user,
    workspace=ws,
    user_type=1,  # Bot
    is_active=True,
    label=label,
    description=description,
)

# Print on a clearly-marked line so the SSM wrapper can grep it out.
print(f"BOT_TOKEN={token.token}")
print(f"  user={user.email}  workspace={ws.slug}  label={label}")
print(f"  token_id={token.id}  created_at={token.created_at}")