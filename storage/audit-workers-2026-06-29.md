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
- Evidence: Every inbound task message allocates a `context` object holding three freshly-created closures (`dispatch`/`release`/`retain`, lines 121-141) plus `released`/`retained` locals — even for the dominant result-only action that never calls them: 4 allocations/task of pure GC pressure. Benchmark-gated for the ≥10% bar; payload/action-cost-dependent.
- Recommendation: Reduce from 4 allocations to 1 — move `released`/`retained` onto a tiny per-task record and define `dispatch`/`release`/`retain` ONCE at module scope, reading state from `this`. **Correctness constraint:** one record per MESSAGE (two interleaved awaited tasks each need their own flags) — preserve per-task isolation.
- Risk: Medium — the context is handed to userland action code via `this`; the closures→shared-functions change must keep observable behavior identical (especially the no-op-when-`released` guards) under interleaved awaits.
- Confidence: MEDIUM
- LOC delta: +20 / -0
- Recommended-model: opus

#### F-50: onmessage heartbeat-arm with flag present but missing/zero interval is untested
- File: src/onmessage.ts:101
- Symbol: default export (heartbeat interval arming)
- Category: test-quality
- Priority: P2
- Evidence: Arming is gated `if (data.heartbeat && data.heartbeatInterval)`. Every hb test passes a truthy interval; the "no config" test sends neither flag. The conforming sub-branch `{heartbeat:true}` with interval omitted/0 (which must NOT arm) is never isolated; a `&&`→`||` mutation survives the suite. DISTINCT from the previously-rejected T3 (which required a non-conforming worker) — this is a conforming arm frame.
- Recommendation: Add two cases — `{heartbeat:true}` with no `heartbeatInterval`, and `{heartbeat:true, heartbeatInterval:0}` — each asserting zero `heartbeat:true` postMessages after advancing the clock.
- Risk: A mutation flipping `&&`→`||` arms `setInterval` with `Math.max(50, NaN→50)` and leaks an unbounded heartbeat interval on a malformed arm frame, undetected.
- Confidence: HIGH
- LOC delta: +16 / -0
- Recommended-model: sonnet

### src/pool.ts

#### F-42: Unvalidated numeric pool options enable self-DoS via the documented config surface
- File: src/pool.ts:48
- Symbol: constructor
- Category: security
- Priority: P2
- Evidence: Only `limit` is validated (`Number.isInteger && >0`, line 56); other numeric `PoolOptions` are taken verbatim. Deep-dive downgraded the original claim: the headline NaN-`heartbeatTimeout` vector is **disproven** (`heartbeatInterval`/`heartbeatTimeout` are gated by `>0` at 162/263, so NaN/negative never arm). Genuine survivors: `idleTimeout:-1` is truthy → `setTimeout(replaceWorker,-1)` fires immediately → terminate-on-availability churn (a plausible sign typo); `retryDelay`/`maxRetryDelay` NaN → 0-backoff retry storm but only when `retries>0`; `shutdownTimeout` negative → zero-grace hard-kill (one-shot). `maxTasksPerWorker` is already safe (`>0` use-site guard, 208). Self-DoS only, not externally triggerable.
- Recommendation: Add a ~5-line `Number.isFinite && range-check` block beside the existing `limit` guard: heartbeat/idle/maxTasks use `>=0` (0 = disabled sentinel); retry/shutdown want `>0`. Floor or throw on non-finite/negative to fail fast rather than silently produce immediate-fire timers.
- Risk: Pool misconfiguration (or a config value derived from app-external input) produces sustained worker spawn/terminate churn (`idleTimeout:-1`) or a retry storm — CPU/process-handle pressure. Bounded to self-DoS within the same trust domain.
- Confidence: MEDIUM (score: 38)
- LOC delta: +6 / -0
- Recommended-model: sonnet

#### F-43: tasksPerWorker get+set maintained on every completion even when the feature is OFF (default)
- File: src/pool.ts:206
- Symbol: createWorker(onmessage completion path)
- Category: optimize
- Priority: P2
- Evidence: The completion handler (hottest fn, once per task) runs `this.tasksPerWorker.get` (206) + `set` (213) per task. When `maxTasksPerWorker===0` (the DEFAULT, line 60 `?? 0`), the `>0` guard at 208 is always false so the count is never read for any decision, yet the get+set still runs to maintain a number nothing uses — unconditional dead work on the default path. Benchmark-gated for the ≥10% bar; the default-path guard is unambiguous removed work regardless.
- Recommendation: Gate the count maintenance behind `if (this.maxTasksPerWorker > 0)` (and skip the `set(worker,0)` init at 224 when off). Implementer's call on sub-point 2 (colocate the count with the worker record when the feature is on) per benchmark.
- Risk: Low — count semantics unchanged; only a guard. Ensure replaceWorker/teardown reset still hold when the feature is on.
- Confidence: HIGH (sub-point) (score: 41)
- LOC delta: +8 / -0
- Recommended-model: sonnet

#### F-44: Proxy handler object re-allocated per proxy() call (hoistable to one-per-pool)
- File: src/pool.ts:627
- Symbol: default proxy factory (apply/get traps)
- Category: optimize
- Priority: P2
- Evidence: Each `proxy(opts)` call (the `pool.foo.bar(args)` entry, on the per-task path for proxy-API callers) allocates a fresh 4-function handler object literal `{apply,deleteProperty,get,set}`. The handlers close only over `pool` (stable for the pool's lifetime), so the handler object can be created ONCE per pool and reused; currently rebuilt per scheduled task. Benchmark-gated for ≥10% (workload-dependent).
- Recommendation: Hoist the handler object to one-per-pool scope (it references only `pool`); each `proxy()` reuses the single instance. Only the per-call target + `new Proxy` remain (they carry per-call `options`/`path`).
- Risk: Low for the hoist (identical behavior — handlers are pure functions of target+pool).
- Confidence: MEDIUM (score: 31)
- LOC delta: +8 / -0
- Recommended-model: sonnet

#### F-48: worker onerror with no .message never exercises the fallback error string
- File: src/pool.ts:112
- Symbol: createWorker (worker.onerror)
- Category: test-quality
- Priority: P2
- Evidence: `task.reject(new Error(e.message ?? '@esportsplus/workers: worker error'))` — every worker-error test emits a message-bearing `Error`, so the `??` default branch (pool.ts:113) is reachable (an error event without `message`) but never taken. A mutation deleting the default survives.
- Recommendation: Add a worker-errors case: `worker._emit('error', {})` (or `{message:undefined}`) while a task is pending → assert `rejects.toThrow('@esportsplus/workers: worker error')`.
- Risk: A regression dropping the fallback yields `Error: undefined` rejections on malformed worker error events — silent loss of the diagnostic message.
- Confidence: HIGH (score: 28)
- LOC delta: +10 / -0
- Recommended-model: sonnet

#### F-49: dispatch timeout-callback stale guard / cleared-timer protection never asserted
- File: src/pool.ts:247
- Symbol: dispatch (task.timeoutId setTimeout callback)
- Category: test-quality
- Priority: P2
- Evidence: The timeout callback opens with `if (!this.pending.has(worker)) return` (249-251), guarding against a timer firing after the task settled / the worker was reassigned. Every timeout test advances the clock while the task is still pending, so the guard is always false. The complete-before-expiry-then-advance-past-deadline case (no spurious recycle) is never asserted.
- Recommendation: Add a fake-timers case (limit:1): schedule `{timeout:500}`, `simulateResult` at t=0, `advanceTimersByTime(500)` → assert `stats().timedOut===0`, `completed===1`, `worker.terminate` not called. Pins `clearTaskTimeout`-on-completion + the `!pending.has` guard.
- Risk: If completion stops clearing the task timeout (or the guard is removed), a stale timer recycles a healthy, already-reassigned worker and inflates `timedOut` — silent worker churn + stats corruption.
- Confidence: MEDIUM (score: 25)
- LOC delta: +12 / -0
- Recommended-model: sonnet

## Convergence Status

- **Status:** DONE
- **Coverage:** 9/9 files (100%)
- **Open findings:** P0=1 · P1=1 · P2=11 (fixed=39, invalid=0)
- **Reason:** full coverage (9/9). Findings, if any, are backlog.

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
