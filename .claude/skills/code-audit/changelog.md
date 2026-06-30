---
project: "@esportsplus/workers"
last_updated: 2026-06-29
counts:
  completed: 48
  rejected: 7
  skipped: 0
  reverted: 3
  blocked: 1
---

# Code-Audit Changelog — @esportsplus/workers

Suppression memory for future audits. Completed = names-only "already done" index (git holds the how — `git log --grep=F-NN`). Rejected = proven dead-ends (irrecoverable from git). Run: spec-implementation of audit-workers-2026-06-29.md.

## Completed

### Correctness
| F-1 collectTransferables cyclic-freeze / diamond DataCloneError (visited WeakSet) |
| F-2 shutdown() hang on hung worker (bounded grace-timeout + force-kill) |
| F-3 retained-worker heartbeat liveness (both-sides: worker heartbeats through retention) |
| F-5 PriorityQueue NaN compare-key guard (throws instead of scrambling dispatch order) |
| F-21 onmessage release() made terminal — single `released` flag honored by post-await branch + retain(); clears orphaned heartbeat (run 2) |
| F-22 PriorityQueue.reprioritize exception-safe — scratch-array all-or-nothing, restore context on NaN throw, no partial heap corruption (run 2) |
| F-26 Pool.shutdown idempotent — memoized in-flight shutdownPromise; re-entry returns same promise, no second grace timer (run 2) |
| F-28 Pool.processQueue self-heals — creates a worker on demand when queued + no available + workers<limit; a worker crash dropping the pool to zero no longer strands queued tasks (promise never settling). Worker-first restructure preserves FIFO order; ships crash-recovery + FIFO-order tests (run 3, P0) |
| F-29 retry backoff timers tracked in `retryTimers` Map; shutdown clears each AND rejects its deferred task ('pool closing') — no leaked handle past shutdown, no stranded promise (run 3, P1) |
| F-30 teardownWorkers reaps idle+heartbeat timer Maps — catches an idle timer armed by markAvailable during the shutdown drain window (single sink, all 3 shutdown exit paths) (run 3, P1) |

### Security / Hardening
| F-27 worker heartbeatInterval clamped to 50ms floor (Math.max), arming still gated; prevents tiny/negative self-DoS (run 2) |
| F-31 inbound worker event channel reserves internal 'release' key — `if(data.event==='release')return` drops a worker {event:'release'} before it fires the internal release listener; blocks no-malice session teardown via event-name collision. legit {release:true} main→worker path intact (run 3, P1) |
| F-32 retained:true idempotent — `if(task.retained)return` guards the retained branch; kills slot-exhaustion (repeated retains pinning workers) + duplicate release-listener fan-out (run 3, P2) |
| F-33 onmessage clearHeartbeat(uuid) before heartbeats.set — duplicate-uuid heartbeat frame replaces the interval instead of orphaning it (timer-leak/flood); F-27 clamp untouched (run 3, P2) |

### Public API / Config
| F-4 limit option honored (no silent clamp to cores-1) + positive-integer validation |

### Modernize / ESM
| F-13 bare require() → createRequire(import.meta.url) (ESM-safe node imports, late-binding preserved) |

### Dedup / Refactor
| F-11 recycleWorker() — centralized timeout/heartbeat/abort teardown |
| F-12 teardownWorkers() — centralized shutdown terminate+clears (absorbed into F-2) |

### Cleanup
| F-9 dead exported type Infer removed |
| F-14 11 restate-the-code comments in pool.ts removed |
| F-34 dead Pool.priorityContext field removed — inlined into the PriorityQueue constructor call; dead context() write dropped (run 3) |
| F-35 Pool.compare demoted from private field to constructor-local — inlined into the PriorityQueue constructor call (run 3) |

### Weak-types
| F-10 Function weak type in flatten() → (...args: unknown[]) => unknown |

### Performance
| F-23 collectTransferables defer `seen` WeakSet — lazy alloc on 2nd container level, push only containers, end-dedup net for duplicate leaf transferables. Bench-gated: +28-31% on shallow-transferable payloads ([buf]/{buffer}/{data,w,h}), nested cases also faster, zero regression. The sanctioned "attack the WeakSet via depth-deferral" variant the F-6/7/8 merged-family note left open. (run 2) |

### Testing / Coverage
| F-15 barrel (index.ts) export-binding test |
| F-16 PriorityQueue direct heap-boundary unit tests |
| F-17 collectTransferables cyclic + diamond tests |
| F-18 pool.context() FIFO no-op coverage |
| F-19 stats() average math pinned to exact values (was assertion-free) |
| F-20 priority() factory return-shape / kind discriminant test |
| F-24 node.ts workerPort parentPort-present branch test (mock parentPort non-null via vi.hoisted + resetModules) (run 2) |
| F-25 platform/browser.ts cores/spawn/workerPort tests (stub navigator/Worker) — shipped web path now covered (run 2) |
| F-36 abort-during-running asserts stats().timedOut===0 — pins recycleWorker countTimeout=false contract (run 3) |
| F-37 maxTasksPerWorker `>=` recycle boundary — both edges pinned (no recycle after task 1, recycle on task 2) (run 3) |
| F-38 worker recreation after full idle teardown (1→0→1 re-grow path) covered (run 3) |
| F-39 retry jitter observed non-zero (Math.random→0.5) + clamp-to-maxRetryDelay overflow case (run 3) |

### Run 4 — spec-implementation of audit-workers-2026-06-29 (2026-06-29)

Correctness
| F-40 release-reply error no longer retries (P0) — a retained session's release-cleanup throw posted {error} that the completion branch fed into retry(), re-executing the action + leaking the worker (re-dispatch's release listener bound to the stale uuid). Tag the round-trip with `task.releasing`, gate retry on `!task.releasing`. |
| F-41 post-shutdown retry-timer leak (P1) — a task erroring in the shutdown grace window armed a retry timer after the one-shot sweep; nothing unref'd it → event loop hung ≤maxRetryDelay (30s). Gate retry on `!this.cleanup` + drain retryTimers in teardownWorkers. |

Security / Hardening
| F-42 validate numeric PoolOptions in constructor — only `limit` was checked; NaN/negative heartbeat/idle/retry/shutdown values produced immediate-fire timers (idleTimeout:-1 churn) / 0-backoff retry storm. Fail-fast `numeric()` helper (>=0 sentinels) + strict >0 guards for retryDelay/maxRetryDelay. |

Dedup / Refactor
| F-44 hoist per-call proxy handler to one-per-pool (behavior-neutral; closes only over pool) |
| F-46 remove redundant heartbeat/idle pre-clears in shutdown() (teardownWorkers reaps them on every exit path; grace-window timer firings verified benign) |

Cleanup
| F-43 skip tasksPerWorker get/set/init when maxTasksPerWorker===0 (default) — counter nothing reads; behavior-neutral, ON-path byte-identical |
| F-47 remove dead Task.worker field (write-only at retention; pending Map owns the binding) |

Testing / Coverage
| F-48 onerror fallback message — emit an error event with no `.message` → rejects with the default string (kills `??`-removal mutation) |
| F-49 dispatch timeout stale-guard — complete before expiry then advance past deadline → no spurious recycle (timedOut=0) |
| F-50 onmessage heartbeat-arm guard — heartbeat:true with interval omitted/0 must not arm (kills `&&`→`||` mutation) |
| F-51 retained release-error single-settle — regression guard for F-40 (retries=0 single reject + retries=1 no re-dispatch) |
| F-52 no leaked retry timer after shutdown — regression guard for F-41 (error in grace window → vi.getTimerCount()===0) |

## Blocked / Deferred

### Performance
| F-45 onmessage per-message context closures (3→1 alloc) | run 4 (2026-06-29); BLOCKED | Perf gate unprovable: the only representative bench (tests/bench/run.ts) is worker_threads IPC-bound with ±40–52% variance; saving 3 closures/task is <0.1% of per-task cost, below the noise floor, so ≥10% cannot be shown. Unlike F-43/F-44 (trivially behavior-neutral), this restructure touches the userland `this` contract + per-message isolation under interleaved awaits, so it cannot land as a risk-free refactor either. Deferred: needs a dedicated in-process allocation micro-bench (no IPC) to justify before implementing. Remains open in the registry. |

## Rejected

### Performance
| F-6 drop double-traversal pre-scan in collectTransferables | +31%..+246% regression on every micro-bench case | Premise "30-50% fewer node visits" empirically false — node-visit count is NOT the bottleneck. The shallow pre-scan short-circuits the common dispatch payload before any allocation; removing it makes that case worse. Bench gate failed; reverted. |
| F-7 lazy alloc / shared frozen EMPTY in collectTransferables | neutral (could not offset F-6/F-8 losses) | Allocation was not the bottleneck. Neutral on its own; reverted as part of the coordinated F-6/7/8 rewrite that net-regressed. |
| F-8 precompute TRANSFERABLE_CTORS array + instanceof loop | regression (part of +31%..+246% rewrite) | Replacing the inlined literal `instanceof` short-circuit chain with an array-of-ctor loop makes the instanceof site megamorphic in V8, defeating inlining; per-call ctor resolution adds globalThis reads. The dominant per-node cost is the F-1 `seen` WeakSet (mandatory for cycle/diamond correctness, unremovable). Reverted. |

**Merged family (F-6/F-7/F-8):** one coordinated rewrite of `collectTransferables`, measured against a post-F-1 baseline via a dedicated direct-call micro-bench (`tests/bench/transfer.ts`, kept as standing regression infra). Output-identical and all 45 transfer tests stayed green, but every payload regressed. Root cause: the optimizations target the wrong bottleneck. A genuine win would have to attack the WeakSet cost (e.g. defer `seen` allocation past a depth threshold) — a different, separately bench-gated finding, not these.

### Correctness
| pool.ts Pool.retry — abort-during-retry-delay double-settle | run_index 2 (2026-06-29); Judge INVALID | Idempotent on the native Promise: `TaskPromise` does not override `reject`, so the second `reject()` on the already-settled promise is a silent no-op. The retry timer's `if(task.aborted){reject;return}` returns before any `available.pop()`/`createWorker`/`dispatch`, so no worker/timer is consumed and no extra rejection event fires. Latent defensive-hygiene only — harmful solely if `reject` is ever wrapped (not the case today). Below the senior mass-approve bar; dropped. |
| onmessage.ts dispatch()-after-release() test (T2) | run 3 (2026-06-29); Judge INVALID | Behavior adjudicated CLEAN by correctness: a worker event arriving after task settlement is dropped by the pool's `tasks.get(uuid)` miss (L134-138) — the correct no-op. A test here pins benign behavior with zero regression-catch value. Dropped. |
| pool.ts heartbeat-arms-regardless-of-config test (T3) | run 3 (2026-06-29); Judge INVALID | Behavior adjudicated CLEAN: the only harmful path (0ms recycle timer) requires a non-conforming worker, which is charter-exempt (outside the same-trust contract). No defect to guard; the test would assert boundary-exempt behavior. Dropped. |

### Security / Hardening
| onmessage.ts:80,169 worker err.stack surfaced to pool error sinks (S2) | run 3 (2026-06-29); Judge INVALID-as-vuln | Within one trust domain the stack frames are the author's OWN paths — intended diagnostics, not a cross-boundary leak. Unconditional stripping is a band-aid that kills debuggability; the only legitimate change is an opt-in `exposeStack` flag, which is a feature request, not a security fix. Dropped as a vuln. |

## Skipped

(none)
