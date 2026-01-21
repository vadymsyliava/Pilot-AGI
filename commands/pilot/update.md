---
name: pilot:update
description: Update Pilot AGI to the latest version. Shows changelog and installs new version. Use when user wants to update or when a new version notification appeared.
allowed-tools: Bash, Read
---

# Update Pilot AGI

You are updating Pilot AGI to the latest version.

## Step 1: Check Current Version

Read the current installed version:
- Global: `~/.claude/pilot-version`
- Local: `./.claude/pilot-version`

## Step 2: Check Latest Version

Run:
```bash
npm view pilot-agi version
```

## Step 3: Compare Versions

If current version equals latest:
```
Pilot AGI is up to date (v{version})
```
And stop.

## Step 4: Show Changelog

If update available, fetch and display the changelog:
```bash
npm view pilot-agi changelog
```

Or show a summary:
```
╔══════════════════════════════════════════════════════════════╗
║                   UPDATE AVAILABLE                           ║
║                                                              ║
║  Current: v{current}                                         ║
║  Latest:  v{latest}                                          ║
╚══════════════════════════════════════════════════════════════╝

What's New in v{latest}:
─────────────────────────────────────────────────────────────

• [Feature 1]
• [Feature 2]
• [Bug fix 1]

─────────────────────────────────────────────────────────────
```

## Step 5: Confirm Update

Ask: "Would you like to update now? (yes/no)"

If yes, proceed. If no, stop.

## Step 6: Run Update

For global installation:
```bash
npx pilot-agi --global
```

For local installation:
```bash
npx pilot-agi --local
```

## Step 7: Confirm Success

```
✓ Updated to v{latest}

Please restart Claude Code to use the new version.
```

## Notes
- Always show what changed before updating
- Never force update without confirmation
- Preserve user's config.json settings
