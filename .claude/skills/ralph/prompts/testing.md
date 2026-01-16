# Testing PRD - Browser Automation

This PRD performs visual comparison testing using browser automation. Your job is to compare live pages against mockups and document discrepancies.

## Key Differences

**You do NOT:**
- Commit code changes (you're testing, not implementing)
- Run typecheck (no code changes)
- Work on a git branch

**You DO:**
- Use the browser automation server for screenshots and interaction
- Create markdown reports documenting discrepancies
- Read/write shared state files when specified

## Browser Automation

Read the browser automation skill for full documentation:
`.claude/skills/browser-automation/SKILL.md`

The server runs at http://localhost:9222 and provides endpoints for creating sessions, taking screenshots, navigating, and executing Playwright code.

## Mockup Comparison Process

1. **Screenshot the mockup**: Load the HTML mockup file and take a full-page screenshot
2. **Read the mockup screenshot**: Use the Read tool to view and understand the expected design
3. **Screenshot the live page**: Navigate to the live URL and take a full-page screenshot
4. **Read the live screenshot**: Compare against the mockup visually
5. **Document discrepancies**: Create a markdown report

## Report Format

```markdown
# [Page Name] - Visual Comparison Findings

**Tested**: [date]
**Mockup**: [path]
**Live URL**: [URL]

## Summary
- Critical: X issues
- Major: Y issues
- Minor: Z issues

## Screenshots
- Mockup: [path]
- Live: [path]

## Findings

### Critical
- [Issue with specific element names]

### Major
- [Issue description]

### Minor
- [Issue description]
```

## Severity Guide

- **Critical**: Broken functionality, missing key elements
- **Major**: Significant visual differences, wrong layout
- **Minor**: Small styling differences, spacing issues

## Important

- Always clean up browser sessions when done
- Read screenshots to actually compare them - don't just take them
- Be specific about discrepancies (element names, expected vs actual)
