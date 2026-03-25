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


## Implemented: Priority 4

### 4.1 Transferable Detection: Avoid Redundant Traversal
Fast-path checks in `collectTransferables`: primitives, shallow primitive-only arrays, and shallow primitive-only plain objects return `[]` immediately without allocating stack/result arrays. +12-62% throughput across all benchmarks.

### 4.3 Queue Draining on Abort
`processQueue()` now fires unconditionally on task abort (not just for running tasks). When a queued task is aborted and a worker is idle, the queue drains past aborted entries immediately instead of waiting for the next completion event.
