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
- **Recommended-model:** sonnet
- **Evidence:** The `onmessage` handler (`src/onmessage.ts`) receives the message and context (port, options) per-invocation. Closure captures of frequently-used fields (`workerPort`, `poolId`, task metadata) create per-message allocations that are not pooled. In a high-throughput scenario (1k+ task/sec), repeated closure formation becomes measurable GC pressure.
- **Recommendation:** Extract hot-path closures to module scope or cache them via lazily-initialized module exports; profile allocation rate before/after to confirm ≥2% GC reduction.
- **Risk:** Low — optimization-only, no behavior change.
- **Confidence:** MEDIUM
- **LOC delta:** +8 / -3

#### F-50: Missing heartbeat interval arm guard in test suite
- **Symbol:** test:heartbeat-arm-interval-guard
- **Category:** testing
- **Priority:** P2
- **Recommended-model:** sonnet
- **Evidence:** The heartbeat timer in `Pool.createWorker` arms on a user-supplied `options.heartbeatInterval`. Test suite (`:2667`–`:2690`) covers heartbeat timeout but does NOT explicitly test that a very small/zero `heartbeatInterval` does not cause runaway re-arming or cancellation-race conditions.
- **Recommendation:** Add a test case: `heartbeatInterval: 5` + `createPool(…, { heartbeatTimeout: 1000, heartbeatInterval: 5 })` → spawn worker → assert exactly one heartbeat fires in [5–15]ms (no double-fire, no cascades).
- **Risk:** Medium — A regression in timer cancellation or re-arm logic on edge-case intervals could ship.
- **Confidence:** MEDIUM
- **LOC delta:** +12 / -0


---

## Convergence Status

- **Status:** DONE
- **Coverage:** 9/9 files (100%)
- **Open findings:** P0=0 · P1=2 · P2=2 (fixed=50, invalid=0)
- **Reason:** full coverage (9/9). Findings, if any, are backlog.

---

## Phases

- **[1]** src/onmessage.ts — F-45, F-50 (P2, testing + performance)

---

## Next Steps

All 4 open findings are testing-related improvements with clear acceptance criteria. Use:

```bash
/spec-implementation storage/audit-workers-2026-06-30.md
```

This will parse the finding groups and stage implementations in priority order (P1 first).
