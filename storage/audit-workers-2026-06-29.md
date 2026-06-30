# Code Audit — @esportsplus/workers

- **Status:** DONE (discovery complete) — implementation backlog open
- **Date:** 2026-06-29
- **Project:** workers (@esportsplus/workers v0.8.1)
- **Commit:** 293ba4fc90807e185669d7da57850f10de509e17
- **Scope:** src/ (run 5; changed files re-audited: src/onmessage.ts, src/pool.ts)
- **Audit depth:** 5 category agents (Opus 4.8, xhigh) + in-session re-sweeps + deep-dive on the 2 HIGH code defects and the security MEDIUM + Judge validation. 13 findings VALID / 0 rejected.

## Coverage

| Metric | Value |
|--------|-------|
| Files covered | 9 / 9 (100%) |
| This run's files | src/onmessage.ts, src/pool.ts (all 5 categories each) |
| Auto-closed (confirmed fixed) | F-28..F-39 (12) — prior run's findings verified resolved in current source |
| New findings | F-40..F-52 (13) |

Both files were re-audited because their hashes changed since run 3 (HEAD = `fix(onmessage): clear heartbeat interval before re-arming`). The other 7 src files remain settled at their prior hashes.

## Findings

### src/onmessage.ts

#### F-45: Per-message context allocates 3 closures + flags even for result-only actions
- File: src/onmessage.ts:119
- Symbol: default export (onmessage handler) — WorkerContext construction
- Category: optimize
- Priority: P2
- Status: BLOCKED — cannot clear the perf gate. The only representative benchmark (tests/bench/run.ts dispatch path) is worker_threads IPC-bound with ±40–52% run-to-run variance; saving 3 closures/task is <0.1% of per-task cost, far below the noise floor, so a ≥10% improvement is unprovable. Unlike F-43/F-44 (trivially behavior-neutral gate/hoist), this restructure materially touches the userland `this` contract and per-message isolation under interleaved awaits, so it cannot be landed as a risk-free refactor either. Deferred as backlog: needs a dedicated in-process allocation micro-bench (no IPC) to justify the change before implementing.
- Evidence: Every inbound task message allocates a `context` object holding three freshly-created closures (`dispatch`/`release`/`retain`, lines 121-141) plus `released`/`retained` locals — even for the dominant result-only action that never calls them: 4 allocations/task of pure GC pressure. Benchmark-gated for the ≥10% bar; payload/action-cost-dependent.
- Recommendation: Reduce from 4 allocations to 1 — move `released`/`retained` onto a tiny per-task record and define `dispatch`/`release`/`retain` ONCE at module scope, reading state from `this`. **Correctness constraint:** one record per MESSAGE (two interleaved awaited tasks each need their own flags) — preserve per-task isolation.
- Risk: Medium — the context is handed to userland action code via `this`; the closures→shared-functions change must keep observable behavior identical (especially the no-op-when-`released` guards) under interleaved awaits.
- Confidence: MEDIUM
- LOC delta: +20 / -0
- Recommended-model: opus

## Implementation Status (spec-implementation run, 2026-06-29)

- **COMPLETED (12):** F-40, F-41, F-42, F-43, F-44, F-46, F-47, F-48, F-49, F-50, F-51, F-52 — committed; spec blocks consumed.
- **BLOCKED (1):** F-45 — perf gate unprovable on the IPC-bound bench + userland-contract risk (see block above). Remains open backlog.
- Test suite: 243 → 259 passing. Bench: no regression (within ±40–52% IPC noise).

## Next Steps

P0/P1 exist → run `/spec-implementation storage/audit-workers-2026-06-29.md`.

Suggested implementation order (dependency-aware):
1. **F-40 (P0)** + its guard **F-51** — release-error-retry: the worker-leak + duplicate-execution defect. Highest impact.
2. **F-41 (P1)** + its guard **F-52** — shutdown retry-timer leak. Pairs naturally with the F-46 shutdown/teardown cleanup (same code region).
3. **F-46, F-47** (mechanical removals, sonnet) — redundant timer pre-clears + dead `Task.worker` field. Low-risk, do alongside the F-41 shutdown edit.
4. **F-42** (sonnet) — option validation block in the constructor.
5. **F-43, F-44, F-45** (perf, benchmark-gated — must show ≥10% or be dropped per spec-implementation's perf gate) — F-43 first (cleanest, default-path dead-work removal).
6. **F-48, F-49, F-50** (sonnet, test-quality) — independent mutation-survivor test gaps.

F-43/F-44/F-45 require `pnpm bench:run` baselines and must clear the ≥10% bar (or not regress >2%) to land; the rest are correctness/cleanup/test work with no benchmark gate.
