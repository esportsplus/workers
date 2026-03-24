# Library Audit: @esportsplus/workers

Audit date: 2026-03-24
Scope: Feature gaps, optimizations, and competitive analysis via web research


## Competitive Landscape

| Library | Weekly DLs | Size | Strengths |
|---------|-----------|------|-----------|
| workerpool | 10.3M | med | Mature, browser+Node, proxy API, task stringification |
| piscina | 5.6M | 800KB | Atomics, concurrentTasksPerWorker, memory limits, stats |
| tinypool | smaller | 38KB | Zero deps, used by Vitest |
| comlink | lower | 1.1KB | Proxy-based RPC, expose/wrap pattern, smallest |
| threads.js | smaller | <10KB | Universal (browser+Node+Electron), observables |
| poolifier | growing | 16KB | Fixed+dynamic pools, published benchmarks |

**Our library (0.6.3)**: ~6 source files, proxy-based API, typed events, retain/release, auto-transferable detection, abort/timeout. Competitive API design closest to comlink's proxy pattern, but with pool management like piscina.


## Priority 2: Important Features

### 2.2 Dead Worker Detection (Heartbeat)

If a worker enters an infinite loop or deadlocks, the pool has no way to detect it. The task timeout covers some cases, but tasks without timeout will hang forever.

**Pattern from Inngest/Temporal:**
- Workers send periodic heartbeat messages
- Pool monitors heartbeat intervals
- If no heartbeat received within threshold, terminate and replace worker
- Heartbeat must be isolated from business logic to avoid false positives

**Recommendation**: Add optional `heartbeatInterval` and `heartbeatTimeout` to PoolOptions.

**Impact**: MEDIUM. Critical for production systems where worker hangs are possible.

### 2.3 Pool Statistics Enhancements

Current `stats()` returns: busy, completed, idle, queued, workers. Missing useful metrics:

**From piscina:**
- Run time histogram (avg, p50, p99, min, max)
- Wait time histogram (queue wait time)
- Tasks failed count
- Tasks timed out count
- Tasks retried count

**Recommendation**: Always-on — no opt-in flag. Overhead is ~4 `performance.now()` calls per task (~40ns) which is negligible vs postMessage cost (1-50µs). Track: `failed`, `timedOut`, `avgRunTime`, `avgWaitTime`. Use running sums (`totalRunTime / completed`) to avoid per-task allocations. Add fields directly to `PoolStats`.

**Impact**: MEDIUM. Essential for observability in production.

### 2.4 Task Retry with Backoff

No retry mechanism exists. If a task fails due to transient error, the caller must implement retry logic.

**Pattern:**
- Exponential backoff with jitter: `delay = baseDelay * 2^attempt + random()`
- Cap at `maxRetryDelay`
- Only retry on task errors (not on abort/timeout)

**Two-level configuration:**

1. **Pool-level defaults** — set via `PoolOptions` at construction. Apply to all tasks unless overridden:
   - `retries?: number` — max retry attempts (default: 0 = disabled)
   - `retryDelay?: number` — base delay in ms for exponential backoff (default: 1000)
   - `maxRetryDelay?: number` — cap on backoff delay (default: 30000)

2. **Per-task overrides** — set via `ScheduleOptions` when scheduling a task. Override pool defaults for that specific task:
   - `retries?: number` — override max retry attempts
   - `retryDelay?: number` — override base delay
   - `maxRetryDelay?: number` — override delay cap

Resolution: per-task value ?? pool-level value ?? built-in default.

**Recommendation**: Add retry fields to both `PoolOptions` and `ScheduleOptions`. Pool stores defaults, `schedule()` merges per-task overrides at dispatch time. Retry state (attempt count) lives on the `Task` object. On task error (not abort/timeout), if attempts remain, re-enqueue with backoff via `setTimeout` then `queue.add()`.

**Impact**: MEDIUM. Reduces boilerplate for callers while allowing fine-grained per-task control.


## Priority 3: Nice-to-Have Features

### 3.4 SharedArrayBuffer Communication Channel

Current communication is 100% postMessage (structured clone + transferables). For high-frequency, small-payload communication, SharedArrayBuffer + Atomics is 2.5-6x faster.

**Pattern:**
- Allocate SharedArrayBuffer at pool creation
- Use lock-free ring buffer (e.g., SPSC pattern) for task dispatch
- Workers read from ring buffer instead of waiting for messages

**Caveat**: Requires secure context (HTTPS) and cross-origin isolation headers (COOP/COEP). Not universally available.

**Recommendation**: Research-only for now. Complex to implement, limited browser support. Worth prototyping if benchmarks show postMessage is the bottleneck.

**Impact**: LOW unless postMessage overhead is measured as a bottleneck.


## Priority 4: Code-Level Optimizations

### 4.1 Transferable Detection: Avoid Redundant Traversal

`collectTransferables` traverses the entire value tree on every `postMessage`. For payloads known to have no transferables (e.g., simple objects/strings), this is wasted work.

**Optimization**: Add a fast-path check — if the value is a primitive, string, or shallow object with only primitive values, skip traversal.

### 4.3 Queue Draining on Abort

When a queued (not yet dispatched) task is aborted, it stays in the queue until a worker picks it up and the `dispatch()` method notices `task.aborted`. For large queues with many aborted tasks, this wastes dequeue cycles.

**Optimization**: Could mark aborted tasks and skip them during `processQueue`. Already partially implemented — the while loop in `processQueue` skips aborted tasks, but they still occupy queue capacity.