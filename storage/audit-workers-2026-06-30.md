# Code Audit: workers (@esportsplus/workers)

- **Project:** @esportsplus/workers (worker pool + task queue)
- **Audit date:** 2026-06-30
- **Commit:** 31271914c90cdc8accc26242f731e2f1161cca43
- **Scope:** `src/` (9 TypeScript files, 0 changes since prior run)
- **Run:** #7 (discovery complete)

---

## Coverage

| File | Status | Categories | Last run |
|------|--------|-----------|----------|
| src/index.ts | ✓ Covered | Correctness, Security, Performance, Architecture, Testing | 4 |
| src/onmessage.ts | ✓ Covered | Correctness, Security, Performance, Architecture, Testing | 5 |
| src/pool.ts | ✓ Covered | Correctness, Security, Performance, Architecture, Testing | 6 |
| src/schedule.ts | ✓ Covered | Correctness, Security, Performance, Architecture, Testing | 3 |
| src/task.ts | ✓ Covered | Correctness, Security, Performance, Architecture, Testing | 1 |
| src/transfer.ts | ✓ Covered | Correctness, Security, Performance, Architecture, Testing | 3 |
| src/types.ts | ✓ Covered | Correctness, Security, Performance, Architecture, Testing | 6 |
| src/platform/browser.ts | ✓ Covered | Correctness, Security, Performance, Architecture, Testing | 4 |
| src/platform/node.ts | ✓ Covered | Correctness, Security, Performance, Architecture, Testing | 4 |

**Project-level checks:** ✓ README present

---

## Findings

### src/onmessage.ts

#### F-45: Per-message context closure overhead (performance optimization)
- **Symbol:** onmessage:per-message-context-closures
- **Category:** performance
- **Priority:** P2
- **Status:** BLOCKED
- **Recommended-model:** sonnet
- **Evidence:** The `onmessage` handler (`src/onmessage.ts`) receives the message and context (port, options) per-invocation. Closure captures of frequently-used fields (`workerPort`, `poolId`, task metadata) create per-message allocations that are not pooled. In a high-throughput scenario (1k+ task/sec), repeated closure formation becomes measurable GC pressure.
- **Recommendation:** Extract hot-path closures to module scope or cache them via lazily-initialized module exports; profile allocation rate before/after to confirm ≥2% GC reduction.
- **Risk:** Low — optimization-only, no behavior change.
- **Confidence:** MEDIUM
- **LOC delta:** +8 / -3
- **Blockers:** Perf gate unprovable — the only representative benchmark (`tests/bench/run.ts`) is worker_threads IPC-bound with ±40–52% variance. Saving 3 closures/task is <0.1% of per-task cost, below noise floor. Cannot demonstrate ≥10% improvement needed for performance feature approval. The fix also touches the userland `this` contract and per-message isolation under interleaved awaits, making it a behavioral change (not a risk-free refactor). **Requires:** a dedicated in-process allocation micro-bench (no IPC variance) to justify the change before implementation.


---

## Convergence Status

- **Status:** DONE
- **Coverage:** 9/9 files (100%)
- **Open findings:** P0=0 · P1=2 · P2=1 (fixed=51, invalid=0)
- **Reason:** full coverage (9/9). Findings, if any, are backlog.

---

## Phases

*(all findings either completed or blocked)*

---

## Next Steps

**Summary:**
- **F-53, F-54:** ✓ COMPLETED (prior runs)
- **F-50:** ✓ COMPLETED (existing test coverage sufficient)
- **F-45:** BLOCKED (performance improvement unmeasurable in current bench environment)

All originally-flagged findings have been processed. Three are done; F-45 remains blocked pending a dedicated micro-bench to prove improvement outside of IPC variance.
