# Code Audit — @esportsplus/workers

- **Status:** DONE (discovery complete — 100% coverage)
- **Date:** 2026-06-29
- **Project:** @esportsplus/workers (v0.8.1)
- **Commit:** 2e371bc4dcc02d6c792da96c65b1fbe6f24fed32
- **Scope:** src/ (7 files, 1206 LOC)

## Coverage

| Metric | Value |
|--------|-------|
| Files covered / total | 7 / 7 (100%) |
| Categories per file | correctness, security, performance, architecture, testing (all 5) |
| Findings | 20 VALID (P0×2, P1×3, P2×15) · 3 dropped by Judge (see Rejected) |

This run audited all 7 source files across all 5 categories (one agent per category, all Opus 4.8), with in-session re-sweeps on every productive finder, 5 deep-dive escalations on the correctness defects, and a single Judge validation pass. Security: 0 findings (same-app worker IPC trust boundary, `Map.get` prototype-safe dispatch, `url`/`require` never message-derived).

## Findings

### src/index.ts

#### F-15: Public barrel (index.ts) has zero test references
- File: src/index.ts:8
- Symbol: barrel (default + named { onmessage, pool, priority })
- Category: coverage
- Priority: P2
- Evidence: `grep tests/` for `from '../src/index'|from '../src'` → no matches. Every test imports submodules directly (`../src/pool`, `../src/onmessage`, …), so a broken or renamed re-export in `src/index.ts` — the entry point consumers of `@esportsplus/workers` actually load — ships undetected.
- Recommendation: Add a 1-test `tests/index.ts` asserting the default + named barrel bindings resolve (`workers.pool === pool`, each named export a function).
- Risk: A regression in the package entry point (dropped export, wrong binding) passes CI because no test loads it.
- Confidence: HIGH
- LOC delta: +12 / -0
- Recommended-model: sonnet

### src/onmessage.ts

#### F-10: `Function` weak type in flatten signature
- File: src/onmessage.ts:48
- Symbol: flatten
- Category: weak-types
- Priority: P2
- Evidence: `flatten(obj: Actions, prefix: string, map: Map<string, Function>)`. `Function` is the banned weak type (any callable, not call-checked). The stored values are `Actions` leaves typed `(...args: unknown[]) => unknown` (types.ts:6); the caller does `action.call(context, ...args)`. The concrete type already exists.
- Recommendation: Replace both `Function` occurrences with `(...args: unknown[]) => unknown` (the `Actions` leaf type). Module-private helper, in-place swap.
- Risk: None — `flatten` is private; the call site already matches the concrete signature. It is the type guarding the IPC dispatch table.
- Confidence: HIGH
- LOC delta: +0 / -0
- Recommended-model: sonnet

### src/pool.ts

#### F-2: shutdown() hangs forever on a hung worker — no grace timeout / force-kill
- File: src/pool.ts:529
- Symbol: shutdown
- Category: correctness
- Priority: P0
- Evidence: shutdown installs `cleanup` that fires only when `pending.size === 0` (gated in the completion path, pool.ts:224). Under DEFAULT config the heartbeat (interval/timeout = 0) and the per-task `timeout` (opt-in, undefined) are both off, so a worker that loops forever never fires onmessage/onerror → `pending` never drains → the returned Promise never resolves. Deep-dive confirmed every settling path (task timeout, heartbeat, onerror, abort) is opt-in; the pool owns `terminate()` and uses it freely elsewhere but withholds any deadline/force-kill fallback here. Repro: worker action `() => { while (true) {} }`; `const p = pool(url); p.act(); await p.shutdown()` hangs forever.
- Recommendation: After signalling release, add a bounded grace period that force-terminates remaining workers and settles still-pending tasks so the completion gate can reach zero. A single shutdown grace-timeout also caps F-3's retained-worker case.
- Risk: A library whose `shutdown()` can never resolve strands the host process; one misbehaving worker defeats orderly teardown.
- Confidence: HIGH (score: 8)
- LOC delta: +12 / -2
- Recommended-model: opus

#### F-3: Retained task clears heartbeat liveness — a dead/hung retained worker is undetectable and leaks
- File: src/pool.ts:172
- Symbol: createWorker (data.retained branch)
- Category: correctness
- Priority: P1
- Evidence: On `{retained}` (pool.ts:172-181) the branch clears BOTH the task timeout and the heartbeat timer, then keeps the pending entry awaiting release. Clearing the task timeout is justified (retained = long-lived); clearing the heartbeat — which measures worker *liveness*, orthogonal to task duration — is not. Deep-dive confirmed a retained worker that hangs after `{retained}` but before release is observed by nothing (a hang produces no event), leaking one pending entry + one bound worker (capacity silently shrinks) and poisoning shutdown (F-2: `pending.size` never reaches 0; shutdown's release post at :529-533 is not wait-bounded).
- Recommendation: On retain, clear only the task timeout — keep (or restart) the heartbeat liveness timer so a dead retained worker is still detected. Related: F-2 (a shared shutdown grace-timeout caps the worst impact).
- Risk: Permanent worker/slot leak + a second trigger for the shutdown hang.
- Confidence: MEDIUM (score: 6)
- LOC delta: +6 / -2
- Recommended-model: opus

#### F-4: `limit` option silently clamped down to MAX_CONCURRENCY; `limit: 0` falsy-collapses
- File: src/pool.ts:84
- Symbol: constructor
- Category: correctness
- Priority: P1
- Evidence: `this.limit = options?.limit && options.limit < MAX_CONCURRENCY ? options.limit : MAX_CONCURRENCY`. A user passing `limit: 32` on an 8-core box (MAX = 7) silently gets 7; `limit: 0` is falsy → short-circuits to MAX. The caller's explicit concurrency request is discarded with no error or warning — a real footgun for IO-bound oversubscription, independent of intent.
- Recommendation: Treat `limit` as the user's override (e.g. `options?.limit ?? MAX_CONCURRENCY`, validated `> 0`); OR, if a hard ceiling at cores-1 is intended, document the clamp and reject/warn on an out-of-range value instead of silently overriding.
- Risk: Surprising silent override of an explicit public-API option.
- Confidence: MEDIUM
- LOC delta: +2 / -1
- Recommended-model: opus

#### F-13: Bare require() inside an ESM (type:module) package — breaks the shipped ESM build
- File: src/pool.ts:12, src/pool.ts:21 (and src/onmessage.ts:17)
- Symbol: MAX_CONCURRENCY (`require('os')`), NodeWorkerWrapper ctor / adapter (`require('worker_threads')`)
- Category: modernize
- Priority: P1
- Evidence: package.json `"type":"module"`; base tsconfig `module:esnext`. Bare `require('os')` (pool.ts:12), `require('worker_threads')` (pool.ts:21), `require('worker_threads')` (onmessage.ts:17) throw `require is not defined` in a true ESM runtime. Proof it is not ESM-safe today: the test harness polyfills global `require` (tests/bench/run.ts:12, tests/pool.ts:35, tests/schedule.ts:35) to paper over the gap the published build cannot. Real runtime correctness defect, not syntax taste.
- Recommendation: Use `createRequire(import.meta.url)` once at module top (guarded by IS_NODE), OR guarded static `import { cpus } from 'node:os'` / `import { Worker, parentPort } from 'node:worker_threads'`; keep the browser branch from evaluating the node imports. Validate BOTH runtimes.
- Risk: Affects the shipped Node ESM path for both the main-thread (pool) and worker (onmessage) entry points.
- Confidence: HIGH
- LOC delta: +2 / -3
- Recommended-model: opus

#### F-11: Duplicated worker-replacement teardown across timeout/heartbeat/abort
- File: src/pool.ts:257-267, 391-406, 468-484
- Symbol: dispatch (timeout closure) / startHeartbeatTimer / schedule (abort listener)
- Category: dedup
- Priority: P2
- Evidence: Three sites repeat delete-pending + delete-task + replaceWorker + push(createWorker) [+ processQueue]; each block ~10-16 LOC, meeting the 3-location / 15-LOC bar. The paths already diverge (abort omits `timedOut++`, heartbeat adds `clearTaskTimeout`) — exactly the drift a shared method prevents.
- Recommendation: Extract a private `failWorker`/`recycleWorker(worker, task?, opts)` centralizing the pending/tasks/replace/create invariant. Touches hot paths — keep each call site behavior-identical (e.g. a `countTimeout` flag). Related: F-12.
- Risk: Single-consumer internal refactor; centralizing the invariant removes a class of state-leak drift bugs.
- Confidence: HIGH
- LOC delta: +10 / -34
- Recommended-model: opus

#### F-12: Duplicated shutdown worker-teardown block
- File: src/pool.ts:539-548 vs 553-563
- Symbol: shutdown (immediate path vs deferred cleanup closure)
- Category: dedup
- Priority: P2
- Evidence: The two blocks are the identical terminate-loop + four clears (`available.length=0`, `tasksPerWorker.clear()`, `workers.length=0`, `tasks.clear()`); the deferred path only adds `resolve()`. A future field addition (e.g. clearing a timers map) must be remembered in two places.
- Recommendation: Extract a private `teardownWorkers()` with the terminate-loop + clears; call it from both the immediate branch and the cleanup closure (closure then calls `resolve()`). Related: F-11.
- Risk: None — both branches already run the same code; extraction is behavior-preserving.
- Confidence: HIGH
- LOC delta: +3 / -9
- Recommended-model: sonnet

#### F-14: Restate-the-code section comments in pool.ts
- File: src/pool.ts:212, 253, 293, 457, 467, 506, 513, 520, 528, 535, 551
- Symbol: Pool method bodies (createWorker, dispatch, processQueue, schedule, shutdown)
- Category: slop
- Priority: P2
- Evidence: 11 single-line comments that restate the immediately-following statement with no why / cross-cut / external anchor (e.g. `// Clear all heartbeat timers` over the `clearTimeout` loop, `// Reject all queued tasks` over the `while (task) task.reject(...)` loop). Matches the comment-lint restating-the-code class; distinct from the KEEP WHY-comments (pool.ts:100, 614-616; schedule.ts header) and the IPC-branch protocol labels.
- Recommendation: Delete the 11 restate-the-code comments. Keep the WHY-comments and the protocol-branch labels.
- Risk: None — comment-only deletion, no behavior or API change.
- Confidence: HIGH
- LOC delta: +0 / -11
- Recommended-model: sonnet

#### F-18: pool.context() FIFO no-op branch unasserted
- File: src/pool.ts:412
- Symbol: context
- Category: test-quality
- Priority: P2
- Evidence: `context()`'s `!this.priorityQueue` early-return (pool.ts:413-415), documented as "No-op when the pool is FIFO," has zero coverage; tests call `.context()` only under a priority scheduler. A regression that throws or wrongly reprioritizes a FIFO pool passes CI.
- Recommendation: Add a FIFO-pool `.context({...})` test: must not throw, dispatch order unchanged, `stats().queued` unchanged.
- Risk: A consumer calling `.context()` on a FIFO pool hits an untested branch.
- Confidence: HIGH
- LOC delta: +10 / -0
- Recommended-model: sonnet

#### F-19: stats() average math asserted only `>= 0` (assertion-free for a division)
- File: src/pool.ts:570
- Symbol: stats
- Category: test-quality
- Priority: P2
- Evidence: Every avgRunTime/avgWaitTime assertion is `toBeGreaterThanOrEqual(0)` (tests/pool.ts:1125/1156/1179/1232) — any non-negative number passes. The actual `totalRunTime/completed` and `totalWaitTime/dispatched` math and the `> 0 ? … : 0` guards are never pinned to a value; a wrong-divisor or off-by-one bug passes.
- Recommendation: Under fake timers, assert avg values (e.g. `totalHeld / N`, wait reflecting a known queue delay) and the zero-completion guard (`avgRunTime === 0` after a timeout/abort).
- Risk: `stats()` is the consumers' observability surface (autoscaling/backpressure); a silently-wrong average misleads tuning with no test to catch it.
- Confidence: HIGH
- LOC delta: +30 / -0
- Recommended-model: sonnet

### src/schedule.ts

#### F-5: NaN from user `compare` silently scrambles PriorityQueue dispatch order
- File: src/schedule.ts:48 (key-write at :91 / :121; comparisons at :48/:52/:72)
- Symbol: add / siftUp / siftDown / reprioritize
- Category: correctness
- Priority: P2
- Evidence: `add` (:91) and `reprioritize` (:121) store `compare(meta, ctx)` as `task.priority` with no validation; the heap compares via `<` and `>=`. A NaN key (e.g. `a.distance - ctx.cam` with `distance` undefined, or `0/0`) makes every comparison false → the NaN task pins at the heap root (dequeued first) and, with ≥2 NaN or a NaN landing mid-`reprioritize` heapify, partially scrambles other tasks' order. Deep-dive confirmed it is bounded — ordering only, no crash/hang/loss, the queue always drains — and requires a caller `compare` bug + pool saturation (the queue only fills when all workers are busy). Affects the `pool.context()` re-rank use case the module exists for.
- Recommendation: Guard the single key-write site in `add`/`reprioritize`: if the computed key is non-finite (`key !== key`), throw a named error (`PriorityQueue: compare returned NaN`). Surface the caller bug rather than coerce — coercion (NaN → +Infinity) would band-aid the upstream defect. Related: F-16.
- Risk: Silent wrong dispatch order under priority scheduling; hard to diagnose because the heap "works."
- Confidence: HIGH (score: 9)
- LOC delta: +3 / -0
- Recommended-model: opus

#### F-16: PriorityQueue heap boundaries unasserted (no direct unit test)
- File: src/schedule.ts:21
- Symbol: PriorityQueue (add / next / reprioritize / length)
- Category: test-quality
- Priority: P2
- Evidence: `grep tests/ PriorityQueue|reprioritize` → no matches; the class is exercised only indirectly via Pool with ≤3-4 queued tasks. Unasserted: `next()` on an empty heap → undefined; the `siftDown` right-child branch (needs ≥5 elements / a multi-level heap); `reprioritize` rebuild with a real order inversion (tests flip only 2 tasks); equal-key ties; empty-heap `reprioritize`.
- Recommendation: Add direct `PriorityQueue` unit tests: empty `next()` → undefined; ascending drain of `[5,3,8,1,9,2,7]` (forces multi-level siftDown incl. right child); `reprioritize` that re-orders; equal keys `[5,5,5]`; empty-heap `reprioritize`. Related: F-5.
- Risk: A `siftDown`/`reprioritize` ordering bug at N>4 — the streaming/viewport re-rank use case — would not be caught.
- Confidence: HIGH
- LOC delta: +60 / -0
- Recommended-model: sonnet

#### F-20: priority() factory return shape / kind discriminant never asserted
- File: src/schedule.ts:10
- Symbol: priority
- Category: test-quality
- Priority: P2
- Evidence: tests pass `priority()` as the pool `schedule` option but never assert its return `{ compare, context, kind: 'priority' }`. The pool reads `.compare`/`.context` but never `.kind`, so the discriminant has zero coverage — a dropped/renamed `kind` or wrong binding is invisible to every existing test.
- Recommendation: Add a 1-test assertion: `priority({compare, context})` → `.kind === 'priority'`, `.compare === compare`, `.context === context` (identity).
- Risk: A consumer or future internal code branching on `scheduler.kind` relies on a field no test guards.
- Confidence: MEDIUM
- LOC delta: +8 / -0
- Recommended-model: sonnet

### src/transfer.ts

#### F-1: Cyclic object reference infinite-loops collectTransferables — main-thread total freeze on every postMessage
- File: src/transfer.ts:51
- Symbol: collectTransferables
- Category: correctness
- Priority: P0
- Evidence: The DFS stack walk (transfer.ts:48-89) has no visited-set: a cyclic arg (`o.self = o`, doubly-linked lists, parent back-refs, `this`-refs) re-pushes the same object forever → `while (stack.length > 0)` never terminates. Deep-dive proved end-to-end reachability with ZERO sanitization: `pool(url)(opts)[m](...args)` → Proxy apply (pool.ts:590) → `task.values` (pool.ts:449) → `collectTransferables(task.values)` (pool.ts:282); worker-side at onmessage.ts:90/133/142/165. The call is synchronous on the library's single most-frequent path, so a cyclic arg from any caller freezes the entire isolate (event loop dead, all promises stall, pool bricked) — a DoS-grade availability fault. The diamond / shared-ArrayBuffer case (`{a: buf, b: {buf}}`, acyclic) double-pushes `buf` → `postMessage(payload, [buf, buf])` throws `DataCloneError` — a second distinct defect closed by the same fix.
- Recommendation: Track visited objects in a `Set`/`WeakSet` during the DFS and skip already-seen nodes; this both terminates cycles and dedups shared references (closing the diamond `DataCloneError`). `structuredClone`'s algorithm tolerates cycles; this hand-rolled scan must too. Related: F-17 (tests), F-6/F-7/F-8 (coordinate the hot-path restructure with this fix).
- Recommendation note: land this before F-6 — both restructure the same walk.
- Risk: Main-thread freeze from a single malformed arg; worker-side variant burns 100% CPU until a task timeout fires (if configured) and loses the result.
- Confidence: HIGH (score: 9)
- LOC delta: +4 / -0
- Recommended-model: opus

#### F-6: Redundant double-traversal of common payloads in collectTransferables
- File: src/transfer.ts:28
- Symbol: collectTransferables
- Category: optimize
- Priority: P2
- Evidence: Hottest path in the library (every postMessage: dispatch + every result/event/release/heartbeat). The shallow fast-path (transfer.ts:34-46) only short-circuits when the top level is fully primitive; the dominant dispatch payload (`task.values`, an args array with any nested object) fails the pre-scan, then the stack loop re-walks the SAME top level a second time. ~30-50% fewer node visits for non-trivial payloads. This restructures the exact walk F-1 fixes — coordinate (land after F-1).
- Recommendation: Drop the separate shallow pre-scan (or make it terminal-only): keep the line-30 primitive guard, then a single stack walk with lazy `result`/`stack` allocation. Related: F-1, F-7.
- Risk: None to consumers — identical `Transferable[]` output; pure internal restructure.
- Confidence: HIGH
- LOC delta: +4 / -22
- Recommended-model: opus

#### F-7: Per-call result/stack array allocation when no transferables (common case)
- File: src/transfer.ts:48
- Symbol: collectTransferables (allocation)
- Category: optimize
- Priority: P2
- Evidence: transfer.ts:48-49 allocate `result[]` and `stack[]` on every call reaching the stack path; the overwhelmingly common result is an empty transferable list. Two short-lived array allocations per postMessage, across dispatch + every result/event/release/heartbeat, is steady GC pressure on the hottest path. ~15-25% allocation reduction for the no-transferable majority.
- Recommendation: Return a module-level frozen shared `EMPTY` array for the zero-transferable case; allocate `result` lazily on first push and defer the `stack` allocation to the first nested container. Related: F-1, F-6.
- Risk: The shared EMPTY must never be mutated — callers pass it straight to `postMessage(transfer)` (no mutation); freeze it to enforce.
- Confidence: HIGH
- LOC delta: +6 / -2
- Recommended-model: sonnet

#### F-8: Per-node typeof-guard chain re-evaluated for every object visited
- File: src/transfer.ts:58
- Symbol: collectTransferables (typeof-chain)
- Category: optimize
- Priority: P2
- Evidence: For every non-primitive node, transfer.ts:58-68 runs up to 10 `typeof X !== 'undefined' && current instanceof X` clauses; the `typeof` global presence is fixed at module load (on Node ~half are permanently absent). Re-evaluating environment detection per node on the every-postMessage path is repeated work. ~10-20% per-node cost on object-heavy payloads.
- Recommendation: At module init, build a `TRANSFERABLE_CTORS` array of the constructors that actually exist (filter on `typeof` once), then test via a tight `instanceof` loop. Related: F-1.
- Risk: None — same set of types matched; constructors captured at load reflect the same environment.
- Confidence: HIGH
- LOC delta: +8 / -11
- Recommended-model: sonnet

#### F-17: No cyclic/diamond test for collectTransferables (the F-1 hazard)
- File: src/transfer.ts:51
- Symbol: collectTransferables
- Category: test-quality
- Priority: P2
- Evidence: tests/transfer.ts has only acyclic-tree inputs; no cyclic (`o.self = o`) or shared-buffer-diamond (`{a: buf, b: {buf}}`) case. The cyclic case hangs (F-1); the diamond case duplicates a transferable → `DataCloneError`. Both reachable from public API, untested.
- Recommendation: Add cyclic + diamond tests pinning the post-fix contract (cyclic → terminates, returns each transferable once; diamond → deduped). Must land with/after F-1. Related: F-1.
- Risk: Regression of the most severe defect in the package would go uncaught.
- Confidence: HIGH
- LOC delta: +25 / -0
- Recommended-model: sonnet

### src/types.ts

#### F-9: Dead exported type Infer
- File: src/types.ts:11
- Symbol: Infer
- Category: loc
- Priority: P2
- Evidence: `grep` over src/ + tests/: only the definition (types.ts:11), its own recursion (:17), and the export list (:133). NOT re-exported by index.ts (the barrel exports `Actions, Comparator, PriorityScheduler, WorkerContext` only). `InferWithEvents` is the variant actually consumed (pool.ts:5,585). Zero consumers.
- Recommendation: Delete the `Infer` type (types.ts:11-18) and its export-list entry. Not public API; removal is safe.
- Risk: None — not in the package export surface, no consumers.
- Confidence: HIGH
- LOC delta: +0 / -9
- Recommended-model: sonnet

## Rejected (dropped by Judge — recorded for provenance, not in the backlog)

- **C2 — onmessage heartbeat-interval overwrite leak (onmessage.ts:116).** INVALID. Deep-dive: unreachable via the shipped pool (a fresh `uuid()` is minted per dispatch/retry; the only follow-up message to a live uuid is `release`, which exits before line 116). Reachable only by misusing the public `onmessage(actions)` entry (two path-messages with the same uuid), with a bounded/self-reaping blast radius. LOW/defensive → excluded. A cheap one-line `clearHeartbeat(uuid)` before :116 is optional hardening, not a bug fix.
- **C3 — retry abort-reset race (pool.ts:342).** INVALID. Deep-dive: single-threaded event-loop semantics make the claimed lost-abort impossible — the `task.aborted=false` reset runs during onmessage (strictly earlier than any abort macrotask), and both orderings settle the promise correctly. The residual is benign wasted-dispatch churn, not a correctness defect.
- **A6 — pool.ts reorg (620 LOC).** INVALID. The architecture agent itself recommended no change; consumer count = 1 fails the high-consumer-count reorg bar. The NodeWorkerWrapper adapter and the proxy factory are the only clean seams if a split is ever wanted later.

## Convergence Status

- **Status:** DONE
- **Coverage:** 7/7 files (100%)
- **Open findings:** P0=2 · P1=3 · P2=15 (fixed=0, invalid=0)
- **Reason:** full coverage (7/7). Findings, if any, are backlog.

## Next Steps

P0/P1 findings exist → run `/spec-implementation storage/audit-workers-2026-06-29.md`. spec-implementation builds its own `## Phases` plan from the file-grouped findings above.

Suggested implementation order (the spec author's recommendation; spec-implementation may re-derive):
1. **F-1** (P0, transfer.ts cyclic freeze) — unblocks F-6 and F-17; the visited-Set fix also closes the diamond `DataCloneError`.
2. **F-2 + F-3** (P0/P1, shutdown hang + retained liveness) — shared root; one shutdown grace-timeout addresses both.
3. **F-13** (P1, require()-in-ESM) — restores an honest ESM build and lets tests drop the `require` polyfill.
4. **F-4** (P1, limit clamp), then the P2 tail (F-5–F-8, F-9–F-12, F-14–F-20).

## Baseline (spec-implementation, captured 2026-06-29)

| Gate | Command | Result |
|------|---------|--------|
| Typecheck | `npx tsc --noEmit` | PASS (0 errors) |
| Tests | `npx vitest run` | 169 passed / 5 files |

Bench (`npx tsx tests/bench/run.ts`, ops/sec) — high IPC variance, round-trip path:

| Benchmark | ops/sec | margin |
|-----------|--------:|--------|
| raw postMessage round-trip | 73995.1 | ±66.00% |
| dispatch + resolve | 53696.0 | ±43.09% |
| 100 tasks concurrent | 1627.3 | ±21.56% |
| 50 tasks sequential | 1184.2 | ±6.78% |
| small payload (number) | 57862.8 | ±36.57% |
| medium payload (1KB string) | 56482.5 | ±39.56% |
| large payload (object 100 keys) | 26626.3 | ±24.71% |

**Perf-gating note (F-6/F-7/F-8):** the round-trip bench does NOT isolate `collectTransferables` — the 100-key payload is all-primitive and short-circuits at the shallow fast-path, never entering the stack walk these findings optimize. The transfer.ts phase adds a dedicated direct-call `collectTransferables` micro-bench (nested/cyclic/diamond payloads that bypass the fast-path) to honestly gate the ≥10% requirement. F-1 is correctness (≤2% regression bar only).

## Phases (spec-implementation worklist — execution order)

Dependency-correct, then easiest-first. `phase = file` (one per-file implementer per phase). Sequential execution (no worktrees): transfer.ts is perf-gated; pool.ts↔onmessage.ts are coupled by F-13 (spans both files); remaining independents are cheap, so parallel ROI is below the worktree/merge risk on this repo.

- **Phase 1 — src/types.ts:** F-9 (delete dead `Infer`).
- **Phase 2 — src/index.ts:** F-15 (barrel resolution test → `tests/index.ts`).
- **Phase 3 — src/onmessage.ts:** F-10 (`Function` → `(...args: unknown[]) => unknown`). (onmessage.ts:17 `require` is fixed under F-13 in Phase 6.)
- **Phase 4 — src/schedule.ts:** F-5 (NaN-key guard) → F-16 (PriorityQueue unit tests) → F-20 (priority() factory test).
- **Phase 5 — src/transfer.ts:** F-1 (visited-Set; P0) → add micro-bench → F-6 (single-walk) → F-7 (lazy alloc / EMPTY) → F-8 (ctor list) → F-17 (cyclic/diamond tests). F-1 lands before F-6/F-17.
- **Phase 6 — src/pool.ts (+ onmessage.ts:17):** F-2 (shutdown grace-timeout; P0) → F-3 (retained heartbeat liveness) → F-4 (limit override) → F-13 (require→ESM, spans onmessage.ts + drops test require-polyfills) → F-11 (recycleWorker dedup) → F-12 (teardownWorkers dedup) → F-18 (FIFO context test) → F-19 (stats avg test) → F-14 (delete slop comments, last so logic edits settle first).
