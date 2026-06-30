/**
 * Standalone benchmark for collectTransferables (stack-walk hot path).
 * Run: npx tsx tests/bench/transfer.ts
 */

import { performance } from 'node:perf_hooks';

import { collectTransferables } from '../../src/transfer';


type BenchResult = {
    name: string;
    nsPerCall: number;
    opsPerSec: number;
};


function benchmark(
    name: string,
    fn: () => void,
    opts: { iterations?: number; warmup?: number } = {}
): BenchResult {
    let iterations = opts.iterations ?? 500000,
        warmup = opts.warmup ?? 50000;

    for (let i = 0; i < warmup; i++) {
        fn();
    }

    let start = performance.now();

    for (let i = 0; i < iterations; i++) {
        fn();
    }

    let elapsedMs = performance.now() - start,
        nsPerCall = (elapsedMs * 1e6) / iterations;

    return {
        name,
        nsPerCall,
        opsPerSec: 1000 / (elapsedMs / iterations)
    };
}

function printResult(r: BenchResult) {
    console.log(
        `  ${r.name.padEnd(45)} ${r.nsPerCall.toFixed(1).padStart(10)} ns/call  ` +
        `${r.opsPerSec.toFixed(0).padStart(12)} ops/sec`
    );
}


let arrayOfObjects: unknown[] = [];

for (let i = 0; i < 50; i++) {
    arrayOfObjects.push({ id: i, value: `v${i}` });
}

let deepChain: Record<string, unknown> = { leaf: 1 };

for (let i = 0; i < 10; i++) {
    deepChain = { next: deepChain, depth: i };
}

let objectHeavy: Record<string, unknown> = {};

for (let i = 0; i < 20; i++) {
    objectHeavy[`k${i}`] = { a: i, b: i + 1 };
}

let dispatchShaped: unknown[] = [{ id: 1, data: { x: 1, y: 2 } }, 'str', 42],
    withTransferables = { buf: new ArrayBuffer(8), nested: { buf2: new ArrayBuffer(8) } };

let sharedBuffer = new ArrayBuffer(8);

let shallowArrayBuffer: unknown[] = [new ArrayBuffer(8)],
    shallowBufferObject = { buffer: new ArrayBuffer(8) },
    shallowDuplicateLeaf: unknown[] = [sharedBuffer, sharedBuffer],
    shallowTypedShape = { data: new ArrayBuffer(1024), height: 100, width: 100 };


console.log(`\n${'─'.repeat(80)}`);
console.log('  collectTransferables — stack-walk micro-bench');
console.log(`${'─'.repeat(80)}`);

printResult(benchmark('nested no-transferable (dispatch-shaped)', () => {
    collectTransferables(dispatchShaped);
}));

printResult(benchmark('nested with transferables', () => {
    collectTransferables(withTransferables);
}));

printResult(benchmark('object-heavy (20 nested-object keys)', () => {
    collectTransferables(objectHeavy);
}));

printResult(benchmark('deep nested no-transferable (10 levels)', () => {
    collectTransferables(deepChain);
}));

printResult(benchmark('array of 50 small objects', () => {
    collectTransferables(arrayOfObjects);
}));

console.log(`${'─'.repeat(80)}`);
console.log('  SHALLOW TRANSFERABLE PAYLOADS (F-23 target — single container level)');
console.log(`${'─'.repeat(80)}`);

printResult(benchmark('shallow [ArrayBuffer]', () => {
    collectTransferables(shallowArrayBuffer);
}));

printResult(benchmark('shallow { buffer }', () => {
    collectTransferables(shallowBufferObject);
}));

printResult(benchmark('shallow { data: buf, w, h }', () => {
    collectTransferables(shallowTypedShape);
}));

printResult(benchmark('shallow [buf, buf] duplicate leaf', () => {
    collectTransferables(shallowDuplicateLeaf);
}));

console.log(`${'─'.repeat(80)}\n`);
