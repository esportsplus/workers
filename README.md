# @esportsplus/workers

Lightweight, type-safe worker pool for **Browser** and **Node.js**. Features proxy-based API, automatic transferable detection, task cancellation, timeouts, and typed per-task events.

## Installation

```bash
pnpm add @esportsplus/workers
```

## Quick Start

### 1. Define Worker Actions

```ts
// worker.ts
import { onmessage } from '@esportsplus/workers';

let actions = {
    math: {
        add(a: number, b: number) {
            return a + b;
        },
        multiply(a: number, b: number) {
            return a * b;
        }
    },
    async fetchData(url: string) {
        let response = await fetch(url);
        return response.json();
    }
};

onmessage(actions);

export type Actions = typeof actions;
```

### 2. Create Pool & Execute Tasks

```ts
// main.ts
import { pool } from '@esportsplus/workers';
import type { Actions } from './worker';

let workers = pool<Actions>('/worker.js');

// Call methods - all return TaskPromise (extends Promise)
let sum = await workers().math.add(1, 2);           // 3
let product = await workers().math.multiply(3, 4);  // 12
let data = await workers().fetchData('https://api.example.com');
```

## Pool Options

```ts
let workers = pool<Actions>('/worker.js', {
    limit: 4,           // Max concurrent workers (default: CPU cores - 1)
    idleTimeout: 30000  // Terminate idle workers after 30s (default: 0 = never)
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | `number` | `cpus - 1` | Maximum worker threads |
| `idleTimeout` | `number` | `0` | MS before idle workers terminate (0 = keep alive) |

## Task Options

### Timeout

Cancel tasks that take too long:

```ts
// Task fails after 5 seconds
let result = await workers({ timeout: 5000 }).math.add(1, 2);
```

### AbortSignal

Cancel tasks programmatically:

```ts
let controller = new AbortController();

// Start task
let promise = workers({ signal: controller.signal }).fetchData(url);

// Cancel it
controller.abort();

// Promise rejects with abort error
await promise; // throws '@esportsplus/workers: task aborted'
```

### Combined

```ts
let controller = new AbortController();

let result = await workers({
    signal: controller.signal,
    timeout: 10000
}).processData(largeDataset);
```

## Transferables

Transferable objects (`ArrayBuffer`, `MessagePort`, `ImageBitmap`, `OffscreenCanvas`) are **automatically detected** and transferred for zero-copy performance. No manual configuration required.

```ts
// ArrayBuffer - automatically transferred (sender loses access)
let buffer = new ArrayBuffer(1024 * 1024 * 8);
let result = await workers().processBuffer(buffer);
// buffer.byteLength === 0 after transfer

// OffscreenCanvas - automatically transferred
let canvas = document.createElement('canvas');
let offscreen = canvas.transferControlToOffscreen();
await workers().render(offscreen);
```

The library recursively scans arguments and return values to find transferables in nested objects and arrays.

## Worker Events

Workers can dispatch typed events back to the main thread during task execution. Events are received on the `TaskPromise` returned by each method call.

### 1. Define Event Types

```ts
// types.ts
type Events = {
    progress: { percent: number; message: string };
    log: { level: string; text: string };
};

export type { Events };
```

### 2. Dispatch from Worker

Access `dispatch` via `this` context in your action functions:

```ts
// worker.ts
import { onmessage, WorkerContext } from '@esportsplus/workers';
import type { Events } from './types';

let actions = {
    async processItems(this: WorkerContext<Events>, items: string[]) {
        for (let i = 0, n = items.length; i < n; i++) {
            this.dispatch('progress', { percent: (i / n) * 100, message: `Processing ${items[i]}` });
            this.dispatch('log', { level: 'info', text: `Item ${i + 1} of ${n}` });

            // ... processing ...
        }

        this.dispatch('progress', { percent: 100, message: 'Complete' });

        return { processed: items.length };
    }
};

onmessage<Events>(actions);

export type Actions = typeof actions;
```

### 3. Listen on Task Promise

Events are scoped to individual task executions via the `TaskPromise.on()` method:

```ts
// main.ts
import { pool } from '@esportsplus/workers';
import type { Actions } from './worker';
import type { Events } from './types';

let workers = pool<Actions, Events>('/worker.js');

// Subscribe to events on the task promise (chainable)
let result = await workers()
    .processItems(['a', 'b', 'c'])
    .on('progress', (data) => {
        console.log(`${data.percent}%: ${data.message}`);
    })
    .on('log', (data) => {
        console.log(`[${data.level}] ${data.text}`);
    });

console.log(result); // { processed: 3 }
```

## Pool Management

### Statistics

```ts
let stats = workers.stats();

// {
//   workers: 4,    // Total workers
//   busy: 2,       // Currently executing
//   idle: 2,       // Available for work
//   queued: 10,    // Tasks waiting
//   completed: 150 // Total completed
// }
```

### Graceful Shutdown

Waits for running tasks, rejects queued tasks:

```ts
await workers.shutdown();
```

## Cross-Platform Support

Works in both Browser (Web Workers) and Node.js (worker_threads):

```ts
// Browser - use URL path
let workers = pool<Actions>('/worker.js');

// Node.js - use file URL
let workers = pool<Actions>(new URL('./worker.js', import.meta.url).href);
```

Workers auto-detect their context - no configuration needed:

```ts
// worker.ts - works in both environments
import { onmessage } from '@esportsplus/workers';

onmessage(actions); // Auto-detects self (browser) or parentPort (node)
```

## Serialization

Data is serialized using the **structured clone algorithm** (native to `postMessage`). Transferable objects are automatically detected and transferred for zero-copy performance.

```ts
// Main thread - pass plain values
let result = await workers().process({ name: 'test', values: [1, 2, 3] });

// Worker - receives plain values, returns plain values
let actions = {
    process(data: { name: string; values: number[] }) {
        return { sum: data.values.reduce((a, b) => a + b, 0) };
    }
};
```

Supported types: primitives, objects, arrays, Date, Map, Set, ArrayBuffer, TypedArrays, and more (see [structured clone docs](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm)).

## API Reference

### `pool<T, E>(url, options?)`

Creates a worker pool.

**Type Parameters:**
- `T` - Actions type (for method typing)
- `E` - Events type (for event typing)

**Returns:** Callable proxy with pool methods

```ts
let workers = pool<Actions, Events>(url, options);

// Execute tasks - returns TaskPromise
workers(taskOptions?).path.to.method(args);

// Pool methods
workers.stats();     // Get pool statistics
workers.shutdown();  // Graceful shutdown
```

### `onmessage<E>(actions)`

Sets up worker-side message handler.

**Type Parameters:**
- `E` - Events type (for dispatch typing)

```ts
onmessage<Events>(actions);
```

### `TaskPromise<T, E>`

Extended Promise returned by task execution. Supports event subscriptions.

```ts
let promise = workers().someMethod(args);

// Subscribe to events (chainable)
promise.on('eventName', (data) => { ... });

// Still a regular Promise
let result = await promise;
```

### `WorkerContext<E>`

Type for the `this` context available in worker actions:

```ts
type WorkerContext<E> = {
    dispatch: <K extends keyof E>(event: K, data: E[K]) => void;
};

// Usage in action (declare this type for TypeScript)
let actions = {
    myAction(this: WorkerContext<Events>, arg: string) {
        this.dispatch('eventName', eventData);
        return result;
    }
};
```

## Features

- **Type-safe** - Full TypeScript inference for methods, args, returns, and events
- **Proxy API** - Chain paths like `workers().namespace.method()`
- **Auto transferables** - ArrayBuffer, MessagePort, ImageBitmap, OffscreenCanvas detected automatically
- **Auto pooling** - Workers created on-demand, recycled automatically
- **Task queue** - Backpressure handling when workers busy
- **Cancellation** - AbortSignal support for task cancellation
- **Timeouts** - Per-task timeout configuration
- **Per-task events** - Typed worker-to-main communication scoped to each task
- **Idle timeout** - Auto-terminate unused workers
- **Crash recovery** - Failed workers replaced automatically
- **Cross-platform** - Browser Web Workers + Node.js worker_threads
