---
generated: 2026-06-30T01:00:00Z
ttl: 3600
source-hash: d1480098
partial-refresh: true
sections-refreshed: [2,7,10]
---

# CONTEXT — @esportsplus/workers

## 1. Project Overview

- **Package**: `@esportsplus/workers` v0.8.1 — "Web worker pool"
- **Type**: ESM library (`"type": "module"`)
- **Entry**: `main` → `./build/index.js`, `types` → `./build/index.d.ts`
- **Browser swap**: `package.json#browser` maps `./build/platform/node.js` → `./build/platform/browser.js`
- **Deps**: `@esportsplus/queue` ^0.2.0 (FIFO queue), `@esportsplus/utilities` ^0.28.0 (`uuid`, `UUID`)
- **Dev**: `vitest` ^4.1.9, `@types/node`, `@esportsplus/typescript` (shared tsconfig)

## 2. File Tree (src/, 1372 LOC)

```
src/
  index.ts              9    barrel — re-exports onmessage, pool, priority + types
  onmessage.ts        179    worker-side message handler (actions dispatch, retain/release, heartbeat)
  pool.ts             660    main-thread Pool class + proxy factory (largest, hottest)
  schedule.ts         154    priority() factory + PriorityQueue min-heap
  task.ts              32    TaskPromise (Promise subclass with event listeners)
  transfer.ts         129    collectTransferables — iterative transferable collection
  types.ts            130    shared type definitions (type-only)
  platform/
    browser.ts         11    cores/spawn/workerPort for browser (Web Worker)
    node.ts            68    cores/spawn/workerPort for node (worker_threads)
```

## 3. Package Scripts

- `build` — `tsc && tsc-alias` (compile + rewrite path aliases)
- `test` — `vitest run`; `test:watch` — `vitest`
- `bench:run` — `npx tsx tests/bench/run.ts`
- `prepare` / `prepublishOnly` — `pnpm build`

## 4. Key Exports (index.ts barrel)

- `default { onmessage, pool, priority }`
- `onmessage` — `<E>(actions: Actions) => void`; registers worker-side handler
- `pool` — `<T,E>(url, options?) => proxy & { context, shutdown, stats }`
- `priority` — `<Meta,Ctx>({compare, context}) => PriorityScheduler`
- types: `Actions, Comparator, PriorityScheduler, WorkerContext`

## 5. Module Map (by rank)

```
pool.ts — main-thread pool: worker lifecycle, scheduling, retries, heartbeat, idle/shutdown (rank #1, centrality 0.55)
  exports: default (pool factory) + Pool (internal class)
  imports: @esportsplus/utilities, @esportsplus/queue, ./platform/node, ./schedule, ./task, ./transfer, ./types
  imported by: ./index

onmessage.ts — worker-side: flatten actions, dispatch, retain/release, heartbeat emit (rank #2, centrality 0.30)
  exports: default (onmessage), Actions
  imports: ./platform/node, ./transfer, ./types
  imported by: ./index

transfer.ts — collectTransferables: iterative DFS over value graph, cycle-safe via WeakSet (rank #3, centrality 0.35)
  exports: collectTransferables
  imports: (none internal)
  imported by: ./onmessage, ./pool

schedule.ts — priority() factory + PriorityQueue binary min-heap (rank #4, centrality 0.30)
  exports: priority, PriorityQueue
  imports: ./types
  imported by: ./index, ./pool

types.ts — shared types (Task, Pool*, Worker*, Actions, Infer*) (rank #5, centrality 0.50, type-only)
  imports: @esportsplus/utilities, ./task
  imported by: index, onmessage, pool, schedule, platform/node, platform/browser

task.ts — TaskPromise: Promise subclass with on()/dispatch() event surface (rank #6, centrality 0.25)
  imports: (none internal)
  imported by: ./pool, ./types

platform/node.ts — node worker_threads adapter: cores/spawn/workerPort (rank #7)
  imports: node:os, node:worker_threads, ./types
  imported by: ./onmessage, ./pool (swapped to browser.ts in browser builds)

platform/browser.ts — browser Web Worker adapter: cores/spawn/workerPort (rank #8)
  imports: ./types
  imported by: (none direct — resolved via package.json browser field)

index.ts — barrel entry (rank #9)
```

## 6. Dependency Graph

### 6a. Import Frequency (internal consumers)

| File | Consumers | Imported by |
|------|-----------|-------------|
| types.ts | 6 | index, onmessage, pool, schedule, platform/node, platform/browser |
| transfer.ts | 2 | onmessage, pool |
| schedule.ts | 2 | index, pool |
| task.ts | 2 | pool, types |
| platform/node.ts | 2 | onmessage, pool |
| onmessage.ts | 1 | index |
| pool.ts | 1 | index |
| platform/browser.ts | 0 | (package.json browser swap) |
| index.ts | 0 | (entry) |

### 6b. Export Usage

- `platform/browser.ts` exports (`cores`, `spawn`, `workerPort`) have 0 static internal consumers — reached only via the `browser` field bundler swap with `platform/node.ts`. Not dead; verify against `package.json#browser`.
- `pool.ts` `Pool` class is module-internal (only the `default` factory is exported).

### 6c. Circular Dependencies

- `types.ts ↔ task.ts`: `types.ts` imports `TaskPromise` from `task.ts`; `task.ts` is self-contained (no import back). **No cycle** (task.ts has no internal imports). types.ts → task.ts is a one-way edge.
- No cycles detected.

### 6d. Dependency Ranking

1. pool.ts (most imports, largest, central orchestrator)
2. types.ts (most consumers, type hub)
3. transfer.ts / onmessage.ts (boundary + hot path)
4. schedule.ts
5. task.ts / platform/*

## 7. File Metrics

| File | LOC | Exports | Imports | Consumers | Complexity | Centrality |
|------|-----|---------|---------|-----------|------------|------------|
| pool.ts | 660 | 1 (+Pool) | 7 | 1 | **high** | 0.55 |
| onmessage.ts | 179 | 2 | 3 | 1 | medium | 0.30 |
| schedule.ts | 154 | 2 | 1 | 2 | medium | 0.30 |
| types.ts | 130 | 13 | 2 | 6 | medium | 0.50 |
| transfer.ts | 129 | 1 | 0 | 2 | medium | 0.35 |
| platform/node.ts | 68 | 3 | 3 | 2 | low | 0.20 |
| task.ts | 32 | 1 | 0 | 2 | low | 0.25 |
| platform/browser.ts | 11 | 3 | 1 | 0 | low | 0.15 |
| index.ts | 9 | 7 | 5 | 0 | low | 0.10 |

## 8. Risk Scoring (audit priority, HIGH→LOW)

**HIGH (>0.6)**
- `pool.ts::Pool` (and factory) — concurrency, timers (heartbeat/idle/timeout/shutdown), worker recycle, retry backoff, abort, proxy. Many interleavings; timer leak / UAF / double-settle surface here. Boundary: spawns workers, postMessage.
- `pool.ts::schedule` / `dispatch` / `createWorker.onmessage` — task state machine across messages.

**MEDIUM (0.3–0.6)**
- `transfer.ts::collectTransferables` — untrusted-shape traversal from worker boundary; WeakSet cycle guard; type-detection chain.
- `onmessage.ts::default` (worker onmessage) — async action dispatch, retain/release double-settle guard, heartbeat interval lifecycle.
- `schedule.ts::PriorityQueue` — heap invariants, NaN guard, reprioritize O(n) rebuild.

**LOW (<0.3)**
- `task.ts::TaskPromise`, `platform/*`, `index.ts`, `types.ts`.

## 9. Test Map

| Source | Test | Notes |
|--------|------|-------|
| index.ts | tests/index.ts | barrel export bindings |
| onmessage.ts | tests/onmessage.ts | |
| pool.ts | tests/pool.ts | largest suite (limit, shutdown, heartbeat, retry, stats, priority scheduling, option validation) |
| schedule.ts | tests/schedule.ts | PriorityQueue heap + priority() factory + NaN |
| task.ts | tests/task.ts | |
| transfer.ts | tests/transfer.ts | cyclic + diamond dedup |
| platform/node.ts | tests/platform.ts | workerPort() parentPort-present branch (F-24) |
| platform/browser.ts | tests/platform-browser.ts | cores/spawn/workerPort (F-25) |
| bench | tests/bench/{run,transfer}.ts, echo-worker.cjs | collectTransferables micro-bench (+ shallow-transferable cases) |

**Gaps**: none outstanding — `platform/*` closed by F-24/F-25; pool priority-scheduler integration + numeric() per-field validation closed by F-53/F-54 (suite 267 passing).

## 10. Recent History

```
4849de2 test(onmessage): pin heartbeat-arm guard against missing/zero interval
91500cd refactor(pool): skip tasksPerWorker bookkeeping when disabled, hoist proxy handler
3f613ca fix(pool): validate numeric pool options in the constructor
03df039 refactor(pool): drop dead Task.worker field and redundant shutdown pre-clears
f9fc153 fix(pool): stop release-reply and post-shutdown errors from retrying
293ba4f fix(onmessage): clear heartbeat interval before re-arming
f8efff5 test(pool): pin timeout/recycle/idle/jitter edges
2668822 refactor(pool): drop dead compare/priorityContext fields
a73976b fix(pool): make duplicate retained:true idempotent
ceec582 fix(pool): reserve internal 'release' worker event key
22167f5 fix(pool): reap idle/heartbeat timers in teardownWorkers
aec5521 fix(pool): reap retry backoff timers on shutdown
c50a8ea fix(pool): recover queued tasks after worker crash
6604e86 test(platform): cover node workerPort + browser entry
96c7e9e perf(transfer): defer seen WeakSet on shallow payloads
b61c37c fix(pool): idempotent shutdown
4ac9c28 fix(onmessage): terminal release + heartbeat clamp
b742b6a fix(schedule): exception-safe reprioritize
2bc1ff3 refactor: static node imports in platform/node + vi.mock
190dacc refactor: move platform modules into src/platform/
```

(audit-workers-2026-06-29 findings F-1..F-52 implemented/rejected across 4 spec-implementation runs — see `.claude/skills/code-audit/changelog.md`. Run 4 (F-40..F-52): release-reply/post-shutdown retry guards (`task.releasing`, `!this.cleanup`, retryTimers reaped in teardownWorkers), numeric PoolOptions validation (`numeric()` helper), tasksPerWorker gating + proxy-handler hoist, dead `Task.worker` removal, redundant shutdown pre-clears removed, +16 mutation-killing tests. F-45 (onmessage closure reduction) BLOCKED — perf gate unprovable on the IPC-bound bench. Suite 259 passing.)

## 11. Build & Dev

- Build: `pnpm build` (`tsc && tsc-alias`) → `./build/`
- Test: `pnpm test` (vitest run)
- Bench: `pnpm bench:run`
- No env vars required.

## 12. Token Usage: ~2150/4000
