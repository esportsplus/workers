# Library Audit: @esportsplus/workers

Audit date: 2026-03-24
Scope: Feature gaps, optimizations, and competitive analysis via web research


## Baseline Benchmarks

- Date: 2026-03-24
- Commit: 554d15e (main)

| Benchmark | ops/sec | mean | p95 |
|-----------|---------|------|-----|
| raw postMessage round-trip | 52,553 | 0.019ms | 0.046ms |
| pool dispatch + resolve (1 worker) | 33,566 | 0.030ms | 0.072ms |
| 100 tasks concurrent (4 workers) | 1,255 | 0.797ms | 1.180ms |
| 50 tasks sequential (4 workers) | 730 | 1.369ms | 2.164ms |
| small payload (number) | 29,789 | 0.034ms | 0.068ms |
| medium payload (1KB string) | 29,859 | 0.033ms | 0.069ms |
| large payload (object 100 keys) | 13,479 | 0.074ms | 0.119ms |

Pool overhead vs raw: ~36% (33,566 vs 52,553 ops/sec for single task).


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
