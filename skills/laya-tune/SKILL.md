# Laya Router Tuning & Evaluation Skill

When invoked, spawn an isolated background subagent via `Agent` tool to inspect logs, resolve flagged misclassifications, update semantic anchors, and trigger daemon hot-reload.

---

## 1. Spawn Tuning Subagent

The Main Agent should immediately spawn a subagent:

```javascript
Agent({
  subagent_type: "general-purpose",
  description: "Tune Laya semantic anchors",
  run_in_background: false,
  prompt: `
    You are the Laya Tuning Subagent. Perform semantic anchor optimization:

    1. INSPECT DATA:
       - Read user corrections: ~/.pi/agent/laya/corrections.jsonl or daemon/corrections.jsonl
       - Read latest 40-50 lines: ~/.pi/agent/laya/predictions.jsonl or daemon/predictions.jsonl
       - Read current anchors: ~/.pi/agent/laya/anchors.json or daemon/anchors.json

    2. ANALYZE & TUNE:
       - Find misclassified prompts and low-confidence items (< 0.35).
       - Determine the best category for each flagged prompt.
       - Append relevant new exemplar phrases into anchors.json under the appropriate category.

    3. HOT-RELOAD & CLEANUP:
       - Trigger in-memory hot-reload via HTTP POST:
         curl -s -X POST http://127.0.0.1:4141/reload-anchors
       - Clear/archive resolved entries in corrections.jsonl (truncate to empty file or clear handled lines).
       - Run sample prediction probes via curl to verify resolution.

    4. RETURN CONCISE SUMMARY:
       - Number of corrections resolved.
       - Categories updated & new exemplars added.
       - Verification status.
  `
})
```

---

## 2. Report to User

When the subagent completes, display a concise summary showing what anchors were updated and verified.
