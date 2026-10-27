# Prompt consistency review — 2026-10-27

Scope: all 10 shipped step templates (including legacy B2.ui_states), the empty shared system template, current feature-delivery dependencies, handler variables/tool access, and all active local prompt overrides. No project/feature prompt-additions files or custom workflow YAML files were found in the inspected FrontFlow data directory. Historical generated reports and session transcripts were not rewritten.

## Findings and changes

| Boundary | Conflict / missing handoff | Resolution |
|---|---|---|
| Static UI → BA review | Provisional frame selection could look authoritative | Mark uncertain variants as provisional, retaining frame ids and uncertainty |
| Static UI → API review/integration | Mock controls could be treated as backend requirements or survive production integration | Exclude dev controls from API coverage; replace production mocks and keep controls dev-only |
| API review → BA review | UI API coverage could be mistaken for coverage of later BA requirements | State the API review scope explicitly; integration records later API gaps |
| BA review → test design | Review required Figma evidence but received names without explicit MCP access | Supply file identity/handoff and enable Figma MCP for the report agent, retaining files-only command restrictions |
| BA review → integration | Local override lacked review input and prohibited UI changes needed by BA | Align override with shipped template, consume missing UI items and accepted decisions |
| Test design → generation | Manual-only cases were allowed upstream but every case was required to become automation | Give manual checks ids/steps/results; explicitly exclude them from automatic generation/verdicts |
| Generation → unit execution | Local override instructed FE fixes inside a node that forbids app edits | Generation fixes tests/helpers only; execution nodes handle FE fixes |
| Unit execution → E2E execution | Local unit prompt ran E2E as well | Unit and E2E stages have separate scopes; preserve CMS clock instruction in E2E override |
| Test design → E2E | Frontend-only scope conflicted with assertions for every role in other apps | Other-app actions are setup/preconditions; assertions target this frontend |
| Optional operations guide → test execution | Agents were told to use fixed guide accounts even when no guide existed | Use documented project fixtures or report setup blockers; never invent data or wait for real time |
| E2E smoke → final verdict | Unreachable smoke environment could become a passing skip | Mark not-run explicitly; required blocked checks cannot yield a passing E2E verdict |
| E2E fixes → final verdict | Rerunning only from failure could miss regressions in earlier stages | Finish with a full feature E2E run after fixes |

Active customized prompts were backed up with the suffix .before-node-conflict-audit.bak and aligned with the defaults. Existing project instructions for the practice lobby and global event subscriptions were preserved. The CMS clock instruction was moved to the E2E step.

## Authority and limitations

BA governs business logic/flow. Design supplies presentation and copy unless BA explicitly mandates exact text. Contract governs transport and codes; it cannot silently change BA outcomes. Tests use source evidence and accepted decisions, never the implementation as the oracle.

This is a source-level consistency review, not a real AI/Figma execution. Automated tests validate wiring and workflow behaviour with fake agents; they do not prove that an AI will interpret every prompt consistently. Existing reports require rerunning the relevant nodes. Historical saved workflow graphs and completed sessions retain their original structure and evidence; they were not migrated by this review.

## Validation

- Root TypeScript typecheck: passed.
- Full test run: 435 tests passed, 4 real-CLI tests skipped. 51 suites passed; the policy suite failed during afterAll cleanup (Windows ENOTEMPTY in its temporary directory), despite all 55 policy assertions passing.
- Isolated policy rerun reproduced the same cleanup failure with all 55 tests passing. No policy source or tests were changed in this review.
- New regression check verifies report agents receive Figma MCP access while shell access stays disabled. Integration checks verify Figma file identity and frame references reach the review prompt.
- Diff whitespace check passed for the files touched by this review.
