---
name: pilot-update
description: Update Pilot AGI to the latest version. Shows changelog and installs new version. Use when update notification appears or to check for updates.
allowed-tools: Bash, Read
---

# Update Pilot AGI

You are updating Pilot AGI to the latest version.

## Step 1: Check current version

```bash
cat .claude/pilot/VERSION 2>/dev/null || echo "unknown"
```

Also check the VERSION.lock for install metadata:
```bash
cat .claude/pilot/VERSION.lock 2>/dev/null
```

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

```bash
# Fetch changelog from GitHub
gh api repos/vadymsyliava/Pilot-AGI/releases/latest --jq '.body' 2>/dev/null || echo "No changelog available"
```

Display:
```
╔══════════════════════════════════════════════════════════════╗
║  UPDATE AVAILABLE                                            ║
╚══════════════════════════════════════════════════════════════╝

  Current: v{current}
  Latest:  v{latest}

WHAT'S NEW
────────────────────────────────────────────────────────────────
{changelog entries}
────────────────────────────────────────────────────────────────

UPGRADE DETAILS
────────────────────────────────────────────────────────────────
  • Your settings.json hooks will be preserved
  • Your policy.yaml customizations will be preserved
  • A backup will be created before upgrading
  • Migrations will run automatically if needed
────────────────────────────────────────────────────────────────
```

## Step 5: Run update

Determine install type from VERSION.lock:
```bash
node -e "try{const v=JSON.parse(require('fs').readFileSync('.claude/pilot/VERSION.lock','utf8'));console.log(v.install_type||'local')}catch{console.log('local')}"
```

Then run:
```bash
npx pilot-agi@latest --{install_type}  # --global or --local
```

For `--force` flag (skip confirmation):
```bash
npx pilot-agi@latest --{install_type}
```

## Step 6: Verify update

```bash
node bin/install.js --verify 2>/dev/null || npx pilot-agi --verify
```

Display each check result.

## Step 7: Report

```
════════════════════════════════════════════════════════════════
✓ Updated to v{new version}

  Backup stored at: .pilot-backup/{timestamp}/
  To rollback:      npx pilot-agi --rollback

Please restart Claude Code to use the new version.
════════════════════════════════════════════════════════════════
```

## Rollback

If user requests rollback:
```bash
npx pilot-agi --rollback --{install_type}
```

## Important Rules
- Always show what's new before updating
- Confirm before updating (unless --force)
- The installer handles config preservation automatically
- Note that restart is required
- Show rollback instructions after update
