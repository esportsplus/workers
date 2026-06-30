# Code Audit — @esportsplus/workers

- **Status:** DONE (discovery complete — full coverage)
- **Date:** 2026-06-30
- **Project:** @esportsplus/workers v0.8.1
- **Commit:** 753bd76
- **Scope:** `src/` (run_index 6) — re-audit of the 2 files changed since run 5 (`src/pool.ts`, `src/types.ts`)

## Coverage

| Metric | Value |
|--------|-------|
| Files covered / total | 9 / 9 (100%) |
| Files audited this run | 2 (`src/pool.ts`, `src/types.ts`) |
| Categories per file | correctness · security · performance · architecture · testing (all 5) |
| Prior findings auto-closed (confirmed fixed) | 11 (F-40–F-44, F-46–F-49, F-51, F-52 on pool.ts) |
| New findings | 2 (F-53, F-54) |

Both changed files were re-audited because run-4's spec-implementation modified them (pool.ts option-validation + refactors; `Task.worker` removed from types.ts). All five category agents (Opus 4.8) confirmed the 11 prior pool.ts findings remain fixed; correctness/security/performance/architecture returned **0 new findings**. Testing surfaced 2 test gaps (one via the in-session re-sweep). The Judge validated both as distinct from prior changelog items.

## Findings

### src/pool.ts

#### F-53: Priority-scheduler branch of pool.ts is entirely untested through createPool
- File: src/pool.ts:90-98 (constructor schedule branch), 482-489 (context reprioritize leg); test target tests/pool.ts
- Symbol: Pool.constructor (schedule branch) + Pool.context (reprioritize path)
- Category: coverage
- Priority: P1 (score: 55)
- Evidence: grep of tests/pool.ts for `schedule:|priorityQueue|PriorityQueue|compare` → **0 matches**. Every `createPool(...)` omits `options.schedule`, so constructor L92-98 (`new PriorityQueue(schedule.compare, schedule.context)`, `this.queue = this.priorityQueue`) never executes and `context()`'s `reprioritize(next)` + `processQueue()` leg (L487-488) has 0 references — only the FIFO no-op leg is tested (tests/pool.ts:1465). tests/index.ts only identity-checks the `priority` export. Distinct from F-16 (PriorityQueue isolated heap unit test) and F-18 (FIFO no-op leg) — neither guards the integration wiring.
- Recommendation: add a `describe('priority scheduling')` block: `createPool('...', { limit: 1, schedule: { compare, context } })`. (1) saturate 1 worker + queue 2 differing-priority tasks, assert dispatch order follows `compare`; (2) call `p.context(newCtx)` and assert the queued order re-ranks against `newCtx` before the next dispatch, distinguishing it from the FIFO no-op at :1465.
- Risk: a regression in PriorityQueue wiring (wrong comparator arg order, `context` not threaded, `reprioritize` not re-ranking, `processQueue` not re-pumped after `context()`) ships undetected — the pool's entire priority feature has no behavioral guard. Public-API export of the package.
- Confidence: HIGH
- LOC delta: +45 / -0
- Recommended-model: sonnet
- Note: [CHANGELOG: similar to F-18 pool.context() FIFO no-op coverage — complementary; F-18 covers the FIFO leg, this covers the priority leg]

## Convergence Status

- **Status:** DONE
- **Coverage:** 9/9 files (100%)
- **Open findings:** P0=0 · P1=2 · P2=2 (fixed=50, invalid=0)
- **Reason:** full coverage (9/9). Findings, if any, are backlog.

(DONE = discovery complete; every in-scope file is covered at its current hash. The 2 open P1 findings above are this run's backlog; the 2 open P2 are pre-existing backlog on files unchanged this run — both below the spec's P0/P1 implementation bar are still tracked in the registry.)

## Next Steps

Two P1 test findings exist (no P0). Both are mechanical, single-file additions to `tests/pool.ts` (`Recommended-model: sonnet`):

```
/spec-implementation storage/audit-workers-2026-06-30.md
```

spec-implementation builds its own `## Phases` plan from the file group above and self-consumes each finding on COMPLETED.

## Phases

Phase = file. Both findings target `tests/pool.ts`; one reused sonnet implementer, sequential, easiest-first. Benchmarking inactive (test-only, no src change). Gate = full vitest suite passes.

- [ ] src/pool.ts — F-53 (priority-scheduling integration tests)
