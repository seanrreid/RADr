---
title: "Code review: acme / audit"
client: "acme"
engagement: "acme-audit"
engagement_type: "security"
date: "2026-10-07"
run: "R-0001"
commit: "0c977cab73326b81d26c769aa406edc497d8c17c"
verdict: "Needs attention"
findings_set: "sha256:e57827a404f50ba021fa520cb228fcffcb209eefa76bdd6e09102b7c90d8a069"
dispositions: "sha256:6aebee0f0ac0d3b11f99ce06e6ab64db454638cae77015196291ca86d6d2bb6a"
---

# Executive summary

<!-- radr:keep id=executive-summary -->
_Write the executive summary here. radr preserves this block when the report is regenerated._
<!-- radr:end -->

# Security posture

| Area | Critical | High | Medium | Low | Info |
| --- | --- | --- | --- | --- | --- |
| Secrets | 1 | 0 | 0 | 0 | 0 |
| Security | 0 | 1 | 1 | 0 | 0 |
| Vulnerable dependencies | 0 | 1 | 1 | 0 | 0 |
| Infrastructure as code | 0 | 0 | 0 | 0 | 0 |
| Licenses | 0 | 0 | 0 | 0 | 0 |

Known-exploited (CISA KEV): 0. Likely to be exploited (EPSS 10% or more): 0. Dismissed findings are not counted.

# Top risks

- **CRITICAL** · AWS key (introduced in commit 98f8ed3e3ef3) (`config/deploy.env:2`, F-0001)
- **HIGH** · Found \`subprocess\` function \`call\` with \`shell=True\`. (`app/main.py:7`, F-0002)
- **HIGH** · npm lodash\@4.17.20: Command Injection in lodash; upgrade to ≥ 4.17.21 (`package-lock.json`, F-0004)

# Secrets

Every credential found must be rotated, including those that exist only in the history: anyone with a clone of the repository has them.

| ID | Severity | Rule | Location | Where |
| --- | --- | --- | --- | --- |
| F-0001 | critical | `gitleaks/aws-access-token` | `config/deploy.env:2` | history only |

# Known vulnerabilities

| Package | Severity | CVEs | Max CVSS | Max EPSS | KEV | Upgrade to |
| --- | --- | --- | --- | --- | --- | --- |
| npm lodash\@4.17.20 | high | 2 | 7.2 | — | — | ≥ 4.17.21 |
| PyPI requests\@2.19.1 | medium | 1 | — | — | — | ≥ 2.20.0 |

# Findings

### Secrets

| ID | Severity | State | Rule | Location | Finding |
| -------- | --------- | ---------- | ---------------------- | ------------------- | -------------------------------- |
| F-0001 | critical | pending | `gitleaks/aws-access-token` | `config/deploy.env:2` | AWS key (introduced in commit 98f8ed3e3ef3) |

### Security

| ID | Severity | State | Rule | Location | Finding |
| -------- | --------- | ---------- | ---------------------- | ------------------- | -------------------------------- |
| F-0002 | high | pending | `opengrep/python_exec_rule-subprocess-popen-shell-true` | `app/main.py:7` | Found \`subprocess\` function \`call\` with \`shell=True\`. |
| F-0005 | medium | pending | `opengrep/javascript_eval_rule-eval-with-expression` | `src/server.ts:6` | The application was found calling the \`eval\` function OR Function() constructor OR setTimeout() OR setInterval() methods. |

### Vulnerable dependencies

2 advisories in 2 package(s). Upgrading each package to the version shown resolves every advisory against it that has a fix.

| Package | Severity | Advisories | Upgrade to | Location | Findings |
| ------------------------ | --------- | ---------- | -------------------- | ----------------- | -------------------- |
| npm lodash\@4.17.20 | high | 1 | ≥ 4.17.21 | `package-lock.json` | F-0004 |
| PyPI requests\@2.19.1 | medium | 1 | ≥ 2.20.0 | `requirements.txt` | F-0006 |

### Code quality

| ID | Severity | State | Rule | Location | Finding |
| -------- | --------- | ---------- | ---------------------- | ------------------- | -------------------------------- |
| F-0003 | low | confirmed | `ruff/F401` | `app/main.py:1` | unused import |

# Readiness for AI-assisted development

AI coding agents run a project's own checks after every change, so how strict those checks are, whether CI enforces them, and how often code switches them off decide how safely agents (and people) can change this codebase. radr's own analysis ignores inline suppressions in lint, SAST and secrets scanning; the counts here measure how often the code relies on them.

| Signal | Observed |
| ---------------------------------------- | ------------------------------------------------------------ |
| Inline suppressions in production code (code that switches a check off) | none |
| TypeScript strict mode | no TypeScript configuration |
| CI runs the checks | no CI configuration found |
| Instructions for AI agents | none |

# Remediation overview

| Wave | Focus | Work items | Findings |
| --- | --- | --- | --- |
| 1 | Fix now (critical and high) | 3 | 3 |
| 2 | Schedule this cycle (medium) | 2 | 2 |
| 3 | Opportunistic (low and info) | 1 | 1 |

The full plan, with effort and acceptance criteria, is in the remediation plan.

# Recommendations

<!-- radr:keep id=recommendations -->
_Consultant recommendations. Preserved across regeneration._
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

# Methodology

This review analyzed commit `0c977cab73326b81d26c769aa406edc497d8c17c` with a pinned, checksum-verified toolchain. Every finding traces to a specific tool's output (rule id and location). No finding was created or rated by an AI model.

| Item | Value |
| --- | --- |
| Engagement type / tier | security / standard |
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
| sast | success |
| sca | success |
| secrets | success |
| tests | success |

**Static analysis (SAST) coverage**

Rule packs: radr authored; vendored permissive (GitLab sast-rules MIT/Apache-2.0, elttam); LGPL-3.0 sub-pack (GitLab sast-rules). Every rule passes its own positive and negative test fixtures. A stack is *supported* when each of its top-10 weakness targets has at least one rule; *partial* stacks list the gaps.

| Stack | Support | Targets | Rules | Gaps |
| --- | --- | --- | --- | --- |
| python | supported | 10/10 | 65 | — |
| typescript-javascript | supported | 10/10 | 91 | — |

Not detectable by automated tools, and outside this review unless listed in the findings: Missing Authorization (CWE-862); Incorrect Authorization (CWE-863); Improper Access Control (CWE-284); Missing Authentication for Critical Function (CWE-306); Authorization Bypass via User-Controlled Key (IDOR) (CWE-639).

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

# Appendix: all findings

| ID | Severity | State | Rule | Location |
| ---------- | ------------ | ------------ | ---------------------------------- | -------------------------------- |
| F-0001 | critical | pending | `gitleaks/aws-access-token` | `config/deploy.env:2` |
| F-0002 | high | pending | `opengrep/python_exec_rule-subprocess-popen-shell-true` | `app/main.py:7` |
| F-0004 | high | pending | `osv-scanner/GHSA-35jh-r3h4-6jhm` | `package-lock.json` |
| F-0005 | medium | pending | `opengrep/javascript_eval_rule-eval-with-expression` | `src/server.ts:6` |
| F-0006 | medium | confirmed | `osv-scanner/PYSEC-2018-28` | `requirements.txt` |
| F-0003 | low | confirmed | `ruff/F401` | `app/main.py:1` |
