"""
Seed Plane User + Profile + WorkspaceMember rows for every entry in
data/users.json where `current=true` and `email` is set.

Runs inside the Plane api container as a Django shell script:

    docker exec api python manage.py shell -c \\
        "exec(open('/tmp/seed-members.py').read())" <workspace-slug> <users.json>

Why this exists: Plane's Community Edition has no API path to create a
workspace member without an interactive sign-in. Pre-seeding users
directly into the DB lets the Jira importer assign them as work-item
assignees by Plane member id immediately, instead of every assignment
being squashed to a description note pending invite acceptance.

Verified safe against `apps/api/plane/authentication/adapter/base.py`
in plane preview branch:

  - `complete_login_or_signup` matches by email first
    (`User.objects.filter(email=email).first()`); a pre-existing row is
    reused on first Google sign-in, no duplicate created.
  - `process_workspace_project_invitations` only acts on invites where
    `accepted=True`; our pre-seeded WorkspaceMember row is never
    duplicated. We delete the corresponding pending invite anyway so
    the admin invitations list isn't confusing.
  - `WorkspaceMember.objects.bulk_create(..., ignore_conflicts=True)`
    in the post-auth flow is also safe even if the timing were off.

Idempotent: re-running on already-seeded users does nothing.
"""

import json
import sys
import uuid

from django.contrib.auth.hashers import make_password
from django.db import transaction

from plane.db.models import (
    Profile,
    User,
    Workspace,
    WorkspaceMember,
    WorkspaceMemberInvite,
)

if len(sys.argv) < 3:
    print("usage: seed-members.py <workspace-slug> <users.json path>", file=sys.stderr)
    sys.exit(1)

workspace_slug = sys.argv[1]
users_path = sys.argv[2]

ws = Workspace.objects.get(slug=workspace_slug)
with open(users_path) as f:
    users = json.load(f)

created_n = existed_n = skipped_n = invites_dropped = failed_n = 0
failures: list[tuple[str, str]] = []

for entry in users.values():
    if not entry.get("current") or not entry.get("email"):
        skipped_n += 1
        continue

    email = entry["email"].lower().strip()
    name_parts = (entry.get("display_name") or "").strip().split(maxsplit=1)
    first_name = name_parts[0] if name_parts else ""
    last_name = name_parts[1] if len(name_parts) > 1 else ""

    # Per-user transaction so one bad row (db constraint, validation,
    # network blip) rolls back its own work but the loop continues
    # for everyone else. Without this an exception mid-batch leaves
    # the operator to figure out who got seeded and who didn't.
    try:
        with transaction.atomic():
            user, created = User.objects.get_or_create(
                email=email,
                defaults={
                    "username": uuid.uuid4().hex,
                    "first_name": first_name,
                    "last_name": last_name,
                    "is_password_autoset": True,
                    "is_email_verified": True,
                    "password": make_password(uuid.uuid4().hex),
                },
            )
            Profile.objects.get_or_create(user=user)
            member, _ = WorkspaceMember.objects.get_or_create(
                workspace=ws, member=user, defaults={"role": 15}
            )
            # Drop any pending invite for this email — the user is a real
            # member now, and accepted=False invites just clutter the admin UI.
            # QuerySet.delete() normally returns (count, by_model_dict) but
            # be defensive in case it's just an int.
            result = WorkspaceMemberInvite.objects.filter(
                workspace=ws, email=email
            ).delete()
            if isinstance(result, tuple):
                invites_dropped += result[0]
            else:
                invites_dropped += result
    except Exception as e:  # noqa: BLE001 — keep going on any failure
        failed_n += 1
        failures.append((email, f"{type(e).__name__}: {e}"))
        print(f"failed:  {email}  ({type(e).__name__}: {e})")
        continue

    if created:
        created_n += 1
        print(f"created: {email}  (member_id={member.id})")
    else:
        existed_n += 1
        print(f"existed: {email}  (member_id={member.id})")

print(
    f"\nsummary: created={created_n}  existed={existed_n}  "
    f"skipped(former-or-no-email)={skipped_n}  failed={failed_n}  "
    f"invites-dropped={invites_dropped}"
)
if failed_n:
    print("\nfailures:")
    for email, msg in failures:
        print(f"  {email}: {msg}")
    sys.exit(1)