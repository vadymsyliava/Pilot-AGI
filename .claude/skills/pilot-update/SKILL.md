---
name: pilot-update
description: Update Pilot AGI to the latest version. Shows changelog and installs new version. Use when update notification appears or to check for updates.
allowed-tools: Bash, Read
---

# Update Pilot AGI

You are updating Pilot AGI to the latest version.

## Step 1: Check current version

Read from `.claude/pilot/VERSION` or global location.

## Step 2: Check for updates

```bash
npm view pilot-agi version 2>/dev/null || echo "not-published"
```

## Step 3: Compare versions

If current equals latest:
```
╔══════════════════════════════════════════════════════════════╗
║  Pilot AGI is up to date                                     ║
║  Version: {version}                                          ║
╚══════════════════════════════════════════════════════════════╝
```

## Step 4: Show changelog if update available

```
╔══════════════════════════════════════════════════════════════╗
║  UPDATE AVAILABLE                                            ║
╚══════════════════════════════════════════════════════════════╝

  Current: v{current}
  Latest:  v{latest}

WHAT'S NEW
────────────────────────────────────────────────────────────────
{changelog entries for new version}

────────────────────────────────────────────────────────────────
Update now? (yes / no)
```

## Step 5: Run update

If confirmed:

```bash
npx pilot-agi --global  # or --local based on installation
```

## Step 6: Verify update

```bash
# Check new version installed
```

## Step 7: Report

```
════════════════════════════════════════════════════════════════
✓ Updated to v{new version}

Please restart Claude Code to use the new version.
════════════════════════════════════════════════════════════════
```

## Important Rules
- Always show what's new before updating
- Confirm before updating
- Preserve user configuration
- Note if restart is required
