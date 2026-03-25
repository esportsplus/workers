/**
 * Standalone benchmark for @esportsplus/workers pool
 * Run: npx tsx tests/bench/run.ts
 */

import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

// Pool source uses require() for conditional Node.js imports — provide it in ESM
(globalThis as Record<string, unknown>).require ??= createRequire(import.meta.url);

let { default: createPool } = await import('../../src/pool');


let workerPath = resolve(import.meta.dirname!, 'echo-worker.cjs');


type BenchResult = {
    hz: number;
    margin: string;
    max: number;
    mean: number;
    min: number;
    name: string;
    samples: number;
};


async function benchmark(
    name: string,
    fn: () => Promise<void>,
    opts: { iterations?: number; warmup?: number } = {}
): Promise<BenchResult> {
    let iterations = opts.iterations ?? 500,
        warmup = opts.warmup ?? 50;

    // Warmup
    for (let i = 0; i < warmup; i++) {
        await fn();
    }

    // Collect samples
    let durations: number[] = [];

    for (let i = 0; i < iterations; i++) {
        let start = performance.now();

        await fn();

        durations.push(performance.now() - start);
    }

    durations.sort((a, b) => a - b);

    let max = durations[durations.length - 1]!,
        mean = durations.reduce((s, d) => s + d, 0) / durations.length,
        min = durations[0]!,
        p95 = durations[Math.floor(durations.length * 0.95)]!,
        stddev = Math.sqrt(durations.reduce((s, d) => s + (d - mean) ** 2, 0) / durations.length);

    return {
        hz: 1000 / mean,
        margin: `±${((stddev / mean) * 100).toFixed(2)}%`,
        max: p95,
        mean,
        min,
        name,
        samples: iterations
    };
}

function printResult(r: BenchResult) {
    console.log(
        `  ${r.name.padEnd(45)} ${r.hz.toFixed(1).padStart(10)} ops/sec  ` +
        `mean=${r.mean.toFixed(3)}ms  min=${r.min.toFixed(3)}ms  p95=${r.max.toFixed(3)}ms  ` +
        `${r.margin}  (${r.samples} samples)`
    );
}

function printSeparator(title: string) {
    console.log(`\n${'─'.repeat(120)}`);
    console.log(`  ${title}`);
    console.log(`${'─'.repeat(120)}`);
}


// ─── Raw worker_threads baseline ───────────────────────────────────

printSeparator('RAW WORKER_THREADS BASELINE');

let rawWorker = new Worker(workerPath),
    rawCounter = 0,
    rawPending = new Map<string, () => void>();

rawWorker.on('message', (data: { uuid: string }) => {
    let resolve = rawPending.get(data.uuid);

    if (resolve) {
        rawPending.delete(data.uuid);
        resolve();
    }
});

// Warmup
await new Promise<void>((res) => {
    rawPending.set('warmup', res);
    rawWorker.postMessage({ args: [0], path: 'echo', uuid: 'warmup' });
});

printResult(await benchmark('raw postMessage round-trip', async () => {
    let id = `raw${rawCounter++}`;

    await new Promise<void>((res) => {
        rawPending.set(id, res);
        rawWorker.postMessage({ args: [42], path: 'echo', uuid: id });
    });
}, { iterations: 2000, warmup: 200 }));

await rawWorker.terminate();


// ─── Pool: single worker ───────────────────────────────────────────

printSeparator('POOL - SINGLE WORKER (limit: 1)');

let pool1 = createPool<{ echo: (v: unknown) => unknown }>(workerPath, { limit: 1 });

// Warmup
await pool1().echo('warmup');

printResult(await benchmark('dispatch + resolve', async () => {
    await pool1().echo(42);
}, { iterations: 2000, warmup: 200 }));

await pool1.shutdown();


// ─── Pool: 4 workers concurrent ────────────────────────────────────

printSeparator('POOL - 4 WORKERS CONCURRENT');

let pool4 = createPool<{ echo: (v: unknown) => unknown }>(workerPath, { limit: 4 });

// Warmup
await Promise.all([pool4().echo(0), pool4().echo(1), pool4().echo(2), pool4().echo(3)]);

printResult(await benchmark('100 tasks concurrent', async () => {
    let promises: Promise<unknown>[] = [];

    for (let i = 0; i < 100; i++) {
        promises.push(pool4().echo(i));
    }

    await Promise.all(promises);
}, { iterations: 200, warmup: 20 }));

printResult(await benchmark('50 tasks sequential', async () => {
    for (let i = 0; i < 50; i++) {
        await pool4().echo(i);
    }
}, { iterations: 100, warmup: 10 }));

await pool4.shutdown();


// ─── Pool: payload sizes ───────────────────────────────────────────

printSeparator('POOL - PAYLOAD SIZES (4 workers)');

let poolPayload = createPool<{ echo: (v: unknown) => unknown }>(workerPath, { limit: 4 }),
    largePayload: Record<string, unknown> = {};

for (let i = 0; i < 100; i++) {
    largePayload[`key${i}`] = `value${i}`.repeat(10);
}

await poolPayload().echo('warmup');

printResult(await benchmark('small payload (number)', async () => {
    await poolPayload().echo(42);
}, { iterations: 2000, warmup: 200 }));

printResult(await benchmark('medium payload (1KB string)', async () => {
    await poolPayload().echo('x'.repeat(1024));
}, { iterations: 2000, warmup: 200 }));

printResult(await benchmark('large payload (object 100 keys)', async () => {
    await poolPayload().echo(largePayload);
}, { iterations: 2000, warmup: 200 }));

await poolPayload.shutdown();


console.log(`\n${'─'.repeat(120)}`);
console.log('  Benchmark complete.');
console.log(`${'─'.repeat(120)}\n`);
