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

### src/pool.ts

#### F-53: Priority-scheduler branch entirely untested via createPool
- **Symbol:** Pool.constructor:schedule-branch
- **Category:** testing
- **Priority:** P1
- **Recommended-model:** opus
- **Evidence:** Constructor lines 92–98 (`new PriorityQueue(schedule.compare, schedule.context)`, `this.queue = this.priorityQueue`) and `context()` method (lines 482–489, reprioritize path) have zero test coverage. Every `createPool(…)` call in `tests/pool.ts` omits `options.schedule`, so the FIFO path is the only exercised leg. Grep of test suite for `schedule:`, `priorityQueue`, `PriorityQueue`, `compare` yields 0 matches. The `tests/index.ts` merely asserts that the `priority` export exists (identity check); it never constructs a priority pool.
- **Recommendation:** Add `describe('priority scheduling')` suite:
  1. Test dispatch order: `createPool('test.js', { limit: 1, schedule: { compare: (a, b, ctx) => (a.meta.priority > b.meta.priority ? -1 : 1), context: { … } } })` → saturate worker + queue 2 tasks with different priorities → assert higher-priority task dispatches first.
  2. Test context reprioritize: call `pool.context(newCtx)` with inverted compare logic → assert queued order is re-ranked against new context before next dispatch.
  3. Distinguish from FIFO no-op at `tests/pool.ts:1465`.
- **Risk:** HIGH — Regression in PriorityQueue constructor wiring (wrong arg order, context not threaded, reprioritize not re-ranking, or processQueue not called) ships undetected. The pool's entire priority feature has no behavioral guard.
- **Confidence:** HIGH
- **LOC delta:** +45 / -0

#### F-54: Validation test suite under-specifies numeric() error messages
- **Symbol:** numeric:per-field-validation
- **Category:** testing
- **Priority:** P1
- **Recommended-model:** opus
- **Evidence:** Test suite (`tests/pool.ts:2780`–`:2825`, `describe('option validation')`) asserts ONLY the field-name substring in each validation error (`.toThrow('idleTimeout')`, `.toThrow('retryDelay')`, etc.). The full message built by `numeric()` (line 19) is `${name} must be ${integer ? 'an integer' : 'a finite number'} >= ${min}`.
  - **Gap 1:** `maxTasksPerWorker` has NO rejection test at all (missing negative, non-integer, NaN cases). Flipping its `integer: true` flag to `false`, or removing its `numeric()` call, still passes.
  - **Gap 2:** `heartbeatInterval` has NO rejection test (only `heartbeatTimeout` at `:2797`). Negative/NaN `heartbeatInterval` reaching dispatch is uncaught.
  - **Gap 3:** The `integer`-clause is never asserted for ANY field. Swapping `integer` true↔false for a tested field (e.g., `retries` accepting `1.5`, or `idleTimeout` rejecting `1.5`) keeps the field-name substring intact, so the test at `:2805`/`:2782` still passes while validation semantics invert.
- **Recommendation:**
  - (a) Add `maxTasksPerWorker: 2.5` test → `.toThrow(/maxTasksPerWorker/)` AND `.toThrow(/integer/)`; add `maxTasksPerWorker: -1` → throws.
  - (b) Add `heartbeatInterval: -1` and `heartbeatInterval: NaN` tests → throws containing `heartbeatInterval`.
  - (c) Pin per-field validation message for each: `retries: 1.5` → `.toThrow(/retries must be an integer >= 0/)`; `idleTimeout: -1` → `.toThrow(/idleTimeout must be a finite number >= 0/)`.
- **Risk:** HIGH — A refactor that mis-sets the `integer` flag or `min` threshold for any field, or omits a field's `numeric()` call (maxTasksPerWorker, heartbeatInterval), could invalidly accept fractional/negative/NaN options that corrupt timer math or recycle counting. Test suite stays green.
- **Confidence:** HIGH
- **LOC delta:** +14 / -0

---

## Convergence Status

- **Status:** DONE
- **Coverage:** 9/9 files (100%)
- **Open findings:** P0=0 · P1=2 · P2=2 (fixed=50, invalid=0)
- **Reason:** full coverage (9/9). Findings, if any, are backlog.

---

## Phases

- **[1]** src/pool.ts — F-53, F-54 (P1, testing)
- **[2]** src/onmessage.ts — F-45, F-50 (P2, testing + performance)

---

## Next Steps

All 4 open findings are testing-related improvements with clear acceptance criteria. Use:

```bash
/spec-implementation storage/audit-workers-2026-06-30.md
```

This will parse the finding groups and stage implementations in priority order (P1 first).
