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

**Our library (0.6.3)**: ~6 source files, proxy-based API, typed events, retain/release, auto-transferable detection, abort/timeout, heartbeat, retry, enhanced stats. Competitive API closest to comlink's proxy pattern with pool management like piscina.


## Implemented

### 1.1 Missing Transferable Types
Added detection for AudioData, MediaSourceHandle, ReadableStream, RTCDataChannel, TransformStream, VideoFrame, WritableStream with `typeof` guards. WebTransport streams caught via inheritance.

### 1.2 Worker Recycling After N Tasks
`maxTasksPerWorker` option in `PoolOptions`. Tracks per-worker task counts, terminates and replaces at threshold.

### 2.2 Dead Worker Detection (Heartbeat)
`heartbeatInterval` and `heartbeatTimeout` in `PoolOptions`. Pool sends config in dispatch payload, monitors deadline timers, terminates+replaces unresponsive workers. Workers auto-heartbeat via setInterval.

### 2.3 Pool Statistics Enhancements
Always-on `failed`, `timedOut`, `avgRunTime`, `avgWaitTime`, `retried` in `PoolStats`. Uses `performance.now()` running sums.

### 2.4 Task Retry with Backoff
Two-level config: pool defaults (`retries`, `retryDelay`, `maxRetryDelay`) + per-task overrides via `ScheduleOptions`. Exponential backoff with jitter. Only retries on task errors.


## Remaining: Priority 3

### 3.4 SharedArrayBuffer Communication Channel

Current communication is 100% postMessage (structured clone + transferables). For high-frequency, small-payload communication, SharedArrayBuffer + Atomics is 2.5-6x faster.

**Pattern:**
- Allocate SharedArrayBuffer at pool creation
- Use lock-free ring buffer (e.g., SPSC pattern) for task dispatch
- Workers read from ring buffer instead of waiting for messages

**Caveat**: Requires secure context (HTTPS) and cross-origin isolation headers (COOP/COEP). Not universally available.

**Recommendation**: Research-only for now. Complex to implement, limited browser support. Worth prototyping if benchmarks show postMessage is the bottleneck.

**Impact**: LOW unless postMessage overhead is measured as a bottleneck.


## Remaining: Priority 4

### 4.1 Transferable Detection: Avoid Redundant Traversal

`collectTransferables` traverses the entire value tree on every `postMessage`. For payloads known to have no transferables (e.g., simple objects/strings), this is wasted work.

**Optimization**: Add a fast-path check — if the value is a primitive, string, or shallow object with only primitive values, skip traversal.

### 4.3 Queue Draining on Abort

When a queued (not yet dispatched) task is aborted, it stays in the queue until a worker picks it up and the `dispatch()` method notices `task.aborted`. For large queues with many aborted tasks, this wastes dequeue cycles.

**Optimization**: Could mark aborted tasks and skip them during `processQueue`. Already partially implemented — the while loop in `processQueue` skips aborted tasks, but they still occupy queue capacity.
