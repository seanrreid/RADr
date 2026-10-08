---
title: "Code review: acme / audit"
client: "acme"
engagement: "acme-audit"
engagement_type: "quality"
date: "2026-10-07"
run: "R-0001"
commit: "0c977cab73326b81d26c769aa406edc497d8c17c"
verdict: "Needs attention"
findings_set: "sha256:560c978770422a710a77f2618e25438b6bc2a11fdf4434c30a0ab6b00923dd98"
dispositions: "sha256:6aebee0f0ac0d3b11f99ce06e6ab64db454638cae77015196291ca86d6d2bb6a"
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
- **HIGH** · Found \`subprocess\` function \`call\` with \`shell=True\`. (`app/main.py:7`, F-0002)
- **HIGH** · npm lodash\@4.17.20: Command Injection in lodash (`package-lock.json`, F-0004)

# Maintainability

| Measure | Value |
| --- | --- |
| Functions analyzed | 0 |
| Complex functions | 0 |
| Complex functions (%) | 0 |
| Duplicated lines (%) | 0 |
| Duplicated blocks | 0 |

0 function(s) are complex enough to be findings (cyclomatic complexity over 15). Duplication is a metric, not a finding per block.

# Findings

### Code quality

| ID | Severity | State | Rule | Location | Finding |
| -------- | --------- | ---------- | ---------------------- | ------------------- | -------------------------------- |
| F-0003 | low | confirmed | `ruff/F401` | `app/main.py:1` | unused import |

### Security

| ID | Severity | State | Rule | Location | Finding |
| -------- | --------- | ---------- | ---------------------- | ------------------- | -------------------------------- |
| F-0002 | high | pending | `opengrep/python_exec_rule-subprocess-popen-shell-true` | `app/main.py:7` | Found \`subprocess\` function \`call\` with \`shell=True\`. |
| F-0005 | medium | pending | `opengrep/javascript_eval_rule-eval-with-expression` | `src/server.ts:6` | The application was found calling the \`eval\` function OR Function() constructor OR setTimeout() OR setInterval() methods. |

### Secrets

| ID | Severity | State | Rule | Location | Finding |
| -------- | --------- | ---------- | ---------------------- | ------------------- | -------------------------------- |
| F-0001 | critical | pending | `gitleaks/aws-access-token` | `config/deploy.env:2` | AWS key (introduced in commit 98f8ed3e3ef3) |

### Vulnerable dependencies

| ID | Severity | State | Rule | Location | Finding |
| -------- | --------- | ---------- | ---------------------- | ------------------- | -------------------------------- |
| F-0004 | high | pending | `osv-scanner/GHSA-35jh-r3h4-6jhm` | `package-lock.json` | npm lodash\@4.17.20: Command Injection in lodash |
| F-0006 | medium | confirmed | `osv-scanner/PYSEC-2018-28` | `requirements.txt` | PyPI requests\@2.19.1: The Requests package before 2.20.0 for Python sends an HTTP Authorization header to an http URI upon receiving a same-hostname https-to-http redirect, which ... |

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

# Methodology

This review analyzed commit `0c977cab73326b81d26c769aa406edc497d8c17c` with a pinned, checksum-verified toolchain. Every finding traces to a specific tool's output (rule id and location). No finding was created or rated by an AI model.

| Item | Value |
| --- | --- |
| Engagement type / tier | quality / standard |
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
