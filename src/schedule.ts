import { Comparator, PriorityScheduler, Task } from './types';


// Opt a pool into priority scheduling. QUEUED tasks (those waiting for a free worker) dispatch in ascending
// `compare(meta, context)` order — lowest first — instead of FIFO; a task dispatched immediately to an idle
// worker is unaffected (no contention, no ordering needed). `compare` reads the per-task `meta` passed via
// ScheduleOptions against a shared `context`; `pool.context(next)` re-evaluates every queued task against an
// updated context (the streaming case: re-rank pending work as the camera/viewport moves). Meta and Ctx are
// inferred, so `compare` and `meta` are type-checked at the call site. No scheduler => the pool stays FIFO.
const priority = <Meta, Ctx>(
    config: { compare: Comparator<Meta, Ctx>; context: Ctx }
): PriorityScheduler<Meta, Ctx> => {
    return { compare: config.compare, context: config.context, kind: 'priority' };
};


// Binary MIN-heap of queued tasks keyed by a cached `priority` number (lower dispatches first). `add`/`next`
// are O(log n); `reprioritize` recomputes every key against a new context and rebuilds bottom-up in O(n). It
// exposes the same `add` / `next` / `length` surface as the FIFO queue so the pool consumes either shape
// through one field. The pool skips aborted tasks at the dequeue site, so `next` returns the raw min.
class PriorityQueue {
    private compare: Comparator<unknown, unknown>;
    private context: unknown;
    private heap: Task[] = [];


    constructor(compare: Comparator<unknown, unknown>, context: unknown) {
        this.compare = compare;
        this.context = context;
    }


    get length(): number {
        return this.heap.length;
    }


    private siftDown(start: number): void {
        let heap = this.heap,
            i = start,
            n = heap.length;

        for (;;) {
            let left = (i << 1) + 1,
                right = left + 1,
                smallest = i;

            if (left < n && (heap[left].priority as number) < (heap[smallest].priority as number)) {
                smallest = left;
            }

            if (right < n && (heap[right].priority as number) < (heap[smallest].priority as number)) {
                smallest = right;
            }

            if (smallest === i) {
                break;
            }

            this.swap(i, smallest);
            i = smallest;
        }
    }

    private siftUp(start: number): void {
        let heap = this.heap,
            i = start;

        while (i > 0) {
            let parent = (i - 1) >> 1;

            if ((heap[i].priority as number) >= (heap[parent].priority as number)) {
                break;
            }

            this.swap(i, parent);
            i = parent;
        }
    }

    private swap(a: number, b: number): void {
        let heap = this.heap,
            t = heap[a];

        heap[a] = heap[b];
        heap[b] = t;
    }


    add(task: Task): void {
        task.priority = this.compare(task.meta, this.context);
        this.heap.push(task);
        this.siftUp(this.heap.length - 1);
    }

    next(): Task | undefined {
        let heap = this.heap,
            n = heap.length;

        if (n === 0) {
            return undefined;
        }

        let root = heap[0],
            last = heap.pop() as Task;

        if (n > 1) {
            heap[0] = last;
            this.siftDown(0);
        }

        return root;
    }

    reprioritize(context: unknown): void {
        let heap = this.heap;

        this.context = context;

        for (let i = 0, n = heap.length; i < n; i++) {
            heap[i].priority = this.compare(heap[i].meta, context);
        }

        for (let i = (heap.length >> 1) - 1; i >= 0; i--) {
            this.siftDown(i);
        }
    }
}


export { priority, PriorityQueue };
