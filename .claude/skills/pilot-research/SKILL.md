---
name: pilot-research
description: Research a topic and store findings in work/research/. Use for domain investigation, API exploration, or understanding unfamiliar areas before planning.
argument-hint: [topic]
allowed-tools: Read, Write, Bash, Glob, Grep, WebFetch, WebSearch
---

# Research Topic

You are researching a topic and documenting findings.

## Arguments
- `$ARGUMENTS` contains the research topic

## Step 1: Understand the research goal

Parse the topic and identify:
- What specific information is needed
- Why it's needed (context from current task if any)
- What sources to check

## Step 2: Conduct research

Use available tools:
- **WebSearch** for general information
- **WebFetch** for specific documentation URLs
- **Grep/Glob** for existing code patterns
- **Read** for local documentation

Focus on:
- Primary sources (official docs, specs)
- Existing patterns in the codebase
- Best practices and conventions

## Step 3: Synthesize findings

Create a research document:

```
╔══════════════════════════════════════════════════════════════╗
║  RESEARCH: {topic}                                           ║
╚══════════════════════════════════════════════════════════════╝

SUMMARY
────────────────────────────────────────────────────────────────
{1-2 paragraph summary of key findings}

KEY FINDINGS
────────────────────────────────────────────────────────────────
1. {finding with source}
2. {finding with source}
3. {finding with source}

RECOMMENDATIONS
────────────────────────────────────────────────────────────────
• {actionable recommendation}
• {actionable recommendation}

SOURCES
────────────────────────────────────────────────────────────────
• {url or file path}
• {url or file path}
```

## Step 4: Save to work/research/

Write findings to `work/research/{topic-slug}.md`:

```markdown
# Research: {topic}

**Date**: {YYYY-MM-DD}
**Context**: {why this research was needed}

## Summary
{summary}

## Key Findings
{findings}

## Recommendations
{recommendations}

## Sources
{sources with links}
```

## Step 5: Update session capsule

Append to `runs/YYYY-MM-DD.md`:

```markdown
### Research: {HH:MM}
- Topic: {topic}
- Output: work/research/{topic-slug}.md
- Key insight: {one-liner}
```

## Step 6: Report

```
────────────────────────────────────────────────────────────────
✓ Research complete

  Topic:  {topic}
  Saved:  work/research/{topic-slug}.md

  Key insight: {most important finding}

────────────────────────────────────────────────────────────────
```

## Important Rules
- Always cite sources
- Prefer primary sources over secondary
- Store results for future reference
- Keep research focused on the specific need
- Don't over-research - get enough to proceed
