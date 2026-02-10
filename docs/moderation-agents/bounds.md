# Moderation Agent Bounds

Bounds define when an agent can auto-act vs. when it must request human approval. Each moderation skill checks bounds before executing. If the action falls outside bounds, the skill returns `{ requiresApproval: true }` and the agent submits an approval request.

@justin: Please fill in the bounds for each section below. For each, define the conditions under which the agent can act autonomously vs. must escalate.

---

## User-Level Bounds

These apply across multiple actions. An agent checks these before deciding what to do with a user.

### Mute User

**Auto-mute conditions:**
<!-- @justin: Under what conditions can the agent auto-mute without human approval? -->
<!-- e.g., user has X+ strikes, user triggered Y content scans, etc. -->

**Always require approval when:**
<!-- @justin: Are there user types that always need human review before muting? -->
<!-- e.g., paying subscribers, creator program members, accounts older than X days, etc. -->

---

### Confirm Mute

**Auto-confirm conditions:**
<!-- @justin: When can the agent auto-confirm a mute (triggering subscription cancellation)? -->

**Always require approval when:**
<!-- @justin: e.g., user has active paid subscription, user is in creator program, etc. -->

---

### Ban User

**Auto-ban conditions:**
<!-- @justin: Under what conditions can the agent auto-ban? -->
<!-- e.g., CSAM detection with high confidence, X+ confirmed strikes, etc. -->

**Always require approval when:**
<!-- @justin: e.g., all bans require approval? Only certain reason codes? -->

---

### Give Strike

**Auto-strike conditions:**
<!-- @justin: Placeholder pending new strike system. When can the agent auto-issue a strike? -->

**Always require approval when:**
<!-- @justin: TBD -->

---

## Content-Level Bounds

These apply to blocking specific content types.

### Block Image

**Auto-block conditions:**
<!-- @justin: e.g., matches blocked perceptual hash (distance < 5), scan returns isBlocked=true, etc. -->

**Always require approval when:**
<!-- @justin: e.g., image is from a paying user, image has X+ reactions, etc. -->

---

### Block Model

**Auto-block conditions:**
<!-- @justin: e.g., test generations all return prohibited content, model description contains prohibited keywords, etc. -->

**Always require approval when:**
<!-- @justin: e.g., model has X+ downloads, model is from creator program member, etc. -->

---

### Block Model Version

**Auto-block conditions:**
<!-- @justin: -->

**Always require approval when:**
<!-- @justin: -->

---

### Block Article

**Auto-block conditions:**
<!-- @justin: e.g., Clavata flags with high confidence, embedded images all blocked, etc. -->

**Always require approval when:**
<!-- @justin: -->

---

### Block Bounty

**Auto-block conditions:**
<!-- @justin: -->

**Always require approval when:**
<!-- @justin: -->

---

### Block Training / Deny Training

**Auto-block conditions:**
<!-- @justin: e.g., dataset scan detects minors with high confidence, same-person detection + no AI metadata, etc. -->

**Always require approval when:**
<!-- @justin: -->

---

## Report-Level Bounds

### Action Report

**Auto-action conditions:**
<!-- @justin: Under what conditions can the agent auto-action a report without human review? -->
<!-- e.g., reporter has high credibility score, content clearly matches violation type, etc. -->

**Always require approval when:**
<!-- @justin: -->

---

### Dismiss Report

**Auto-dismiss conditions:**
<!-- @justin: e.g., reporter has low credibility, content scan shows nothing wrong, etc. -->

**Always require approval when:**
<!-- @justin: -->

---

## NCMEC Report

**Always requires human approval.** No auto-action under any circumstance.

The agent prepares the report with:
- Safe/blurred images only
- VLM description of content
- Link for human to review if needed

Human approves the prepared report, which then gets submitted to NCMEC.

---

## General Principles

<!-- @justin: Any overarching rules? For example: -->
<!-- - "Never auto-act on users who have spent > $X" -->
<!-- - "Always require approval for first-time offenders" -->
<!-- - "Auto-action is only for cases where confidence > 95%" -->
<!-- - "All auto-actions must be logged and reviewable" -->
