import { afterEach, describe, expect, it, vi } from 'vitest';
import { cores, spawn, workerPort } from '../src/platform/browser';


describe('platform/browser', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });


    describe('cores', () => {
        it('returns navigator.hardwareConcurrency', () => {
            vi.stubGlobal('navigator', { hardwareConcurrency: 8 });

            expect(cores()).toBe(8);
        });
    });


    describe('spawn', () => {
        it('constructs a Worker with the given url and module type', () => {
            let calls: [string, WorkerOptions][] = [];

            class MockWorker {
                constructor(url: string, options: WorkerOptions) {
                    calls.push([url, options]);
                }
            }

            vi.stubGlobal('Worker', MockWorker);

            spawn('worker.js');

            expect(calls).toHaveLength(1);
            expect(calls[0][0]).toBe('worker.js');
            expect(calls[0][1]).toEqual({ type: 'module' });
        });
    });


    describe('workerPort', () => {
        it('returns null', () => {
            expect(workerPort()).toBeNull();
        });
    });
});
