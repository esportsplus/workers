# @esportsplus/workers

Lightweight, type-safe worker pool for **Browser** and **Node.js**. Features proxy-based API, automatic msgpack serialization, task cancellation, timeouts, and typed worker-to-pool events.

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
        add: (a: number, b: number) => a + b,
        multiply: (a: number, b: number) => a * b
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

// Call methods - all return Promises
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

## Worker Events

Workers can dispatch typed events to the main thread.

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

```ts
// worker.ts
import { onmessage, WorkerContext } from '@esportsplus/workers';
import type { Events } from './types';

let actions = {
    async processItems(items: string[], { dispatch }: WorkerContext<Events>) {
        for (let i = 0, n = items.length; i < n; i++) {
            dispatch('progress', { percent: (i / n) * 100, message: `Processing ${items[i]}` });
            dispatch('log', { level: 'info', text: `Item ${i + 1} of ${n}` });

            // ... processing ...
        }

        dispatch('progress', { percent: 100, message: 'Complete' });

        return { processed: items.length };
    }
};

onmessage<Events>(actions);

export type Actions = typeof actions;
```

### 3. Listen in Main Thread

```ts
// main.ts
import { pool } from '@esportsplus/workers';
import type { Actions } from './worker';
import type { Events } from './types';

let workers = pool<Actions, Events>('/worker.js');

// Subscribe to events (fully typed)
workers.on('progress', (data) => {
    console.log(`${data.percent}%: ${data.message}`);
});

workers.on('log', (data) => {
    console.log(`[${data.level}] ${data.text}`);
});

// Execute task
await workers().processItems(['a', 'b', 'c']);

// Unsubscribe
workers.off('progress', handler);
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

All data is automatically serialized using **msgpack** - faster and smaller than JSON. You work with plain JavaScript values; the library handles encoding/decoding internally.

```ts
// Main thread - pass plain values
let result = await workers().process({ name: 'test', values: [1, 2, 3] });

// Worker - receives plain values, returns plain values
let actions = {
    process: (data: { name: string; values: number[] }) => {
        return { sum: data.values.reduce((a, b) => a + b, 0) };
    }
};
```

Supported types: primitives, objects, arrays, Date, Map, Set, Uint8Array.

## API Reference

### `pool<T, E>(url, options?)`

Creates a worker pool.

**Type Parameters:**
- `T` - Actions type (for method typing)
- `E` - Events type (for event typing)

**Returns:** Callable proxy with pool methods

```ts
let workers = pool<Actions, Events>(url, options);

// Execute tasks
workers(taskOptions?).path.to.method(args);

// Pool methods
workers.on(event, handler);    // Subscribe to event
workers.off(event, handler);   // Unsubscribe
workers.stats();               // Get pool statistics
workers.shutdown();            // Graceful shutdown
```

### `onmessage<E>(actions)`

Sets up worker-side message handler.

**Type Parameters:**
- `E` - Events type (for dispatch typing)

```ts
onmessage<Events>(actions);
```

### `WorkerContext<E>`

Type for the context object passed to worker actions:

```ts
type WorkerContext<E> = {
    dispatch: <K extends keyof E>(event: K, data: E[K]) => void;
};

// Usage in action
let action = (arg: string, { dispatch }: WorkerContext<Events>) => {
    dispatch('eventName', eventData);
};
```

## Features

- **Type-safe** - Full TypeScript inference for methods, args, returns, and events
- **Proxy API** - Chain paths like `workers().namespace.method()`
- **Automatic serialization** - msgpack encoding/decoding handled internally
- **Auto pooling** - Workers created on-demand, recycled automatically
- **Task queue** - Backpressure handling when workers busy
- **Cancellation** - AbortSignal support for task cancellation
- **Timeouts** - Per-task timeout configuration
- **Events** - Typed worker-to-main communication
- **Idle timeout** - Auto-terminate unused workers
- **Crash recovery** - Failed workers replaced automatically
- **Cross-platform** - Browser Web Workers + Node.js worker_threads
