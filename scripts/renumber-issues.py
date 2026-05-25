"""
Renumber Plane issues to match the original Jira sequence numbers.

Plane assigns its own sequence_id at insert time (1, 2, 3, ...), so a
migration that imported 1199 Jira issues from a project numbered up
to WZ-1258 ends up densely 1..1199 — losing the original numbers.

This script reads each Plane issue's `external_id` (set by the
importer to e.g. "WZ-1117"), parses the integer suffix, and updates
both `Issue.sequence_id` and the matching `IssueSequence.sequence`
row to that value.

Safe to run after a fresh migration. Re-running is idempotent:
already-renumbered issues are no-ops.

Usage (inside the api container):

    docker exec plane-api-1 python manage.py shell -c \\
        "exec(open('/tmp/renumber-issues.py').read())" \\
        <workspace-slug> <project-uuid> [--dry-run]

Verified against `apps/api/plane/db/models/issue.py` in upstream
preview:
  - Issue.sequence_id is plain Integer with no unique constraint
  - IssueSequence.sequence is PositiveBigInt with a db_index but
    no unique constraint
  - Plane's auto-increment logic in Issue.save() uses
    `IssueSequence.objects.filter(project=project).aggregate(Max("sequence"))`,
    so future new issues will land at <max-existing> + 1, which is
    what we want.
"""

import re
import sys

from django.db import transaction

from plane.db.models import Issue, IssueSequence, Project, Workspace

if len(sys.argv) < 3:
    print("usage: renumber-issues.py <workspace-slug> <project-uuid> [--dry-run]", file=sys.stderr)
    sys.exit(1)

workspace_slug = sys.argv[1]
project_id = sys.argv[2]
dry_run = "--dry-run" in sys.argv[3:]

ws = Workspace.objects.get(slug=workspace_slug)
project = Project.objects.get(id=project_id, workspace=ws)
print(f"Renumbering Plane issues in {project.identifier} ({project.name})")

KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]+-(\d+)$")

issues = Issue.objects.filter(project=project, external_id__isnull=False).select_related()
print(f"  candidates: {issues.count()} issues with external_id")

planned: list[tuple[Issue, int]] = []
skipped_no_match = 0
already_correct = 0
for issue in issues:
    m = KEY_PATTERN.match(issue.external_id or "")
    if not m:
        skipped_no_match += 1
        continue
    target = int(m.group(1))
    if issue.sequence_id == target:
        already_correct += 1
        continue
    planned.append((issue, target))

print(f"  already correct:    {already_correct}")
print(f"  to renumber:        {len(planned)}")
print(f"  external_id unmatched: {skipped_no_match}")

if dry_run:
    print("DRY RUN — no writes")
    for issue, target in planned[:10]:
        print(f"  {issue.external_id}: {issue.sequence_id} -> {target}")
    if len(planned) > 10:
        print(f"  ... and {len(planned) - 10} more")
    sys.exit(0)

# Two-phase update to avoid hitting any (currently-unenforced but
# possible-future) unique constraint mid-rewrite. Phase 1 moves every
# row to a temp range that's guaranteed above BOTH the current max
# sequence AND the highest target we'll ever set, so neither phase
# can collide with a row that hasn't moved yet. Phase 2 then sets
# each row to its real target.
max_existing = (
    IssueSequence.objects.filter(project=project).order_by("-sequence").values_list("sequence", flat=True).first()
    or 0
)
max_target = max((target for _, target in planned), default=0)
TEMP_BASE = max(max_existing, max_target) + 1
print(
    f"  max existing sequence: {max_existing}, max target: {max_target}"
    f" → using temp base {TEMP_BASE}"
)

# Helpful: cache IssueSequence rows by issue id.
seq_rows: dict = {}
for s in IssueSequence.objects.filter(project=project, issue__in=[i.id for i, _ in planned]):
    seq_rows[s.issue_id] = s

failed = 0
moved_temp = 0

with transaction.atomic():
    # Phase 1: move every row to a unique temp value.
    print("  Phase 1: parking rows in temp range...")
    for index, (issue, _) in enumerate(planned):
        temp = TEMP_BASE + index
        try:
            issue.sequence_id = temp
            issue.save(update_fields=["sequence_id"])
            seq = seq_rows.get(issue.id)
            if seq:
                seq.sequence = temp
                seq.save(update_fields=["sequence"])
            moved_temp += 1
        except Exception as e:
            print(f"    {issue.external_id}: park failed ({e})")
            failed += 1

    # Phase 2: set each row to its real target.
    print("  Phase 2: setting target sequences...")
    set_real = 0
    for issue, target in planned:
        try:
            issue.sequence_id = target
            issue.save(update_fields=["sequence_id"])
            seq = seq_rows.get(issue.id)
            if seq:
                seq.sequence = target
                seq.save(update_fields=["sequence"])
            set_real += 1
        except Exception as e:
            print(f"    {issue.external_id}: set failed ({e})")
            failed += 1

print()
print(f"summary:")
print(f"  parked in temp:    {moved_temp}")
print(f"  set to target:     {set_real}")
print(f"  failures:          {failed}")
if failed:
    sys.exit(1)