---
title: "Code review: acme / audit"
client: "acme"
engagement: "acme-audit"
engagement_type: "triage"
date: "2026-10-07"
run: "R-0001"
commit: "0c977cab73326b81d26c769aa406edc497d8c17c"
verdict: "Needs attention"
findings_set: "sha256:4cdbaeedd4481c9ed8c214d6dea9a1fea7a5fd9d2fd817fd7c80da2b66f7b775"
dispositions: "sha256:6a8da0d9f666d09e0969318fe8e7a55f3e57f2c59d371d5d8e4bb9491b5cb924"
---

# Executive summary

<!-- radr:keep id=executive-summary -->
_Write the executive summary here. radr preserves this block when the report is regenerated._
<!-- radr:end -->

# At a glance

**Overall: Needs attention**

| Area | Result | Value |
| -------------------------------------------------- | -------------- | ------------------------------------ |
| Known-vulnerable dependencies | Watch | high present |
| Secrets in code or history | Watch | history only |
| Lint errors per 1,000 lines (×10) | Not measured | — |
| Type errors | Not measured | — |
| Duplicated code (%) | Good | 0 |
| Functions with complexity \> 15 (%) | Good | 0 |
| Test code vs. source code (%) | Not measured | — |
| Bus factor (authors covering 50% of recent commits) | At risk | 1 |
| Churn in complex files (%) | Not measured | — |

# Top risks

- **CRITICAL** · AWS key (introduced in commit 98f8ed3e3ef3) (`config/deploy.env:2`, F-0001)
- **HIGH** · npm lodash\@4.17.20: Command Injection in lodash; upgrade to ≥ 4.17.21 (`package-lock.json`, F-0003)

# Methodology

This review analyzed commit `0c977cab73326b81d26c769aa406edc497d8c17c` with a pinned, checksum-verified toolchain. Every finding traces to a specific tool's output (rule id and location). No finding was created or rated by an AI model.

| Item | Value |
| --- | --- |
| Engagement type / tier | triage / triage |
| Run | R-0001 (complete) |
| Tools | gitleaks 8.30.1, hadolint 2.15.1, lizard 1.24.1, opengrep 1.30.1, osv-scanner 2.6.0, pandoc 3.12, ruff 0.16.10, scc 4.1.0, scorecard 5.5.0, syft 1.54.1, typst 0.15.1 |
| Toolchain | host (pinned binaries) |
| Sandbox | none |
| Vulnerability data | OSV 20261001-31d692f06c3b; EPSS: none; KEV: none |
| Severity rubric | v2 |
| AI (LLM) policy | off |
| Network | offline (declared) |
| Dismissed / waived findings | 0 / 0 |

**Lanes**

| Lane | Outcome |
| --- | --- |
| census | success |
| history | success |
| lint | success |
| maint | success |
| sca | success |
| secrets | success |
| tests | success |

**Gaps**

- no EPSS snapshot pinned: EPSS promotion skipped (run \`radr db sync\`, then re-scope)
- no KEV snapshot pinned: known-exploited promotion skipped (run \`radr db sync\`, then re-scope)

**Severity definitions**

| Severity | Meaning |
| -------------- | -------------------------------------------------------------------------------------- |
| critical | Likely exploitable now with serious impact (data breach, takeover, known-exploited vulnerability). Fix immediately. |
| high | Exploitable or high-impact weakness requiring attention this cycle. |
| medium | Real weakness or significant quality risk; schedule remediation. |
| low | Minor weakness or quality issue; fix opportunistically. |
| info | Observation or metric context; no action required on its own. |
