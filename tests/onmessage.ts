import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Actions } from '../src/types';


describe('onmessage', () => {
    let onmessageHandler: ((e: { data: unknown }) => void) | null,
        postMessageSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.resetModules();

        onmessageHandler = null;
        postMessageSpy = vi.fn();

        vi.stubGlobal('self', {
            postMessage: postMessageSpy,
            set onmessage(fn: (e: { data: unknown }) => void) {
                onmessageHandler = fn;
            }
        });

        vi.doMock('../src/transfer', () => ({
            collectTransferables: vi.fn(() => [])
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    async function setup(actions: Actions) {
        let mod = await import('../src/onmessage');

        mod.default(actions);

        if (!onmessageHandler) {
            throw new Error('onmessage handler was not set by adapter()');
        }

        return onmessageHandler;
    }

    async function send(handler: (e: { data: unknown }) => void, data: unknown) {
        await handler({ data });

        // Allow microtasks to flush
        await new Promise((r) => setTimeout(r, 0));
    }


    describe('flatten (indirect via message routing)', () => {
        it('routes to a top-level function', async () => {
            let handler = await setup({
                add: function (this: unknown, a: unknown, b: unknown) { return (a as number) + (b as number); }
            });

            await send(handler, { args: [2, 3], path: 'add', uuid: '1' });

            expect(postMessageSpy).toHaveBeenCalledWith(
                { result: 5, uuid: '1' },
                []
            );
        });

        it('routes to a nested function via dot-separated path', async () => {
            let handler = await setup({
                math: {
                    multiply: function (this: unknown, a: unknown, b: unknown) { return (a as number) * (b as number); }
                }
            });

            await send(handler, { args: [4, 5], path: 'math.multiply', uuid: '2' });

            expect(postMessageSpy).toHaveBeenCalledWith(
                { result: 20, uuid: '2' },
                []
            );
        });

        it('returns error for non-existent path', async () => {
            let handler = await setup({ add: () => 0 });

            await send(handler, { args: [], path: 'nonexistent', uuid: '3' });

            expect(postMessageSpy).toHaveBeenCalledWith({
                error: "@esportsplus/workers: path does not exist 'nonexistent'",
                uuid: '3',
            });
        });

        it('skips falsy values in actions', async () => {
            let handler = await setup({
                nope: undefined as unknown as (() => void)
            });

            await send(handler, { args: [], path: 'nope', uuid: '4' });

            expect(postMessageSpy).toHaveBeenCalledWith({
                error: "@esportsplus/workers: path does not exist 'nope'",
                uuid: '4',
            });
        });
    });


    describe('message handling', () => {
        it('ignores messages without uuid', async () => {
            let handler = await setup({ fn: () => 1 });

            await send(handler, { path: 'fn', args: [] });

            expect(postMessageSpy).not.toHaveBeenCalled();
        });

        it('ignores null data', async () => {
            let handler = await setup({ fn: () => 1 });

            await send(handler, null);

            expect(postMessageSpy).not.toHaveBeenCalled();
        });

        it('ignores messages without path and without release', async () => {
            let handler = await setup({ fn: () => 1 });

            await send(handler, { uuid: '5' });

            expect(postMessageSpy).not.toHaveBeenCalled();
        });

        it('calls action with provided args', async () => {
            let spy = vi.fn(function (this: unknown, ...args: unknown[]) { return args; }),
                handler = await setup({ work: spy });

            await send(handler, { args: ['a', 'b', 'c'], path: 'work', uuid: '6' });

            expect(spy).toHaveBeenCalledWith('a', 'b', 'c');
        });

        it('provides WorkerContext as this binding', async () => {
            let captured: unknown = null,
                handler = await setup({
                    capture: function (this: unknown) {
                        captured = this;
                    }
                });

            await send(handler, { args: [], path: 'capture', uuid: '7' });

            expect(captured).toHaveProperty('dispatch');
            expect(captured).toHaveProperty('release');
            expect(captured).toHaveProperty('retain');
        });

        it('returns result via postMessage', async () => {
            let handler = await setup({
                greet: function (this: unknown) { return 'hello'; }
            });

            await send(handler, { args: [], path: 'greet', uuid: '8' });

            expect(postMessageSpy).toHaveBeenCalledWith(
                { result: 'hello', uuid: '8' },
                []
            );
        });

        it('handles async actions', async () => {
            let handler = await setup({
                asyncWork: async function (this: unknown) { return 42; }
            });

            await send(handler, { args: [], path: 'asyncWork', uuid: '9' });

            expect(postMessageSpy).toHaveBeenCalledWith(
                { result: 42, uuid: '9' },
                []
            );
        });
    });


    describe('retain/release lifecycle', () => {
        it('sends retained:true when context.retain() is called', async () => {
            let handler = await setup({
                hold: function (this: { retain: (fn?: () => void) => void }) {
                    this.retain();
                }
            });

            await send(handler, { args: [], path: 'hold', uuid: '10' });

            expect(postMessageSpy).toHaveBeenCalledWith(
                { retained: true, uuid: '10' }
            );
        });

        it('stores cleanup fn when retain is called with one', async () => {
            let cleanupSpy = vi.fn(() => 'cleaned'),
                handler = await setup({
                    hold: function (this: { retain: (fn?: () => void) => void }) {
                        this.retain(cleanupSpy);
                    }
                });

            await send(handler, { args: [], path: 'hold', uuid: '11' });

            // Now send release message from pool
            await send(handler, { release: true, uuid: '11' });

            expect(cleanupSpy).toHaveBeenCalled();
            expect(postMessageSpy).toHaveBeenCalledWith(
                { result: 'cleaned', uuid: '11' },
                []
            );
        });

        it('context.release() sends result immediately', async () => {
            let handler = await setup({
                releaseEarly: function (this: { release: (result?: unknown) => void; retain: (fn?: () => void) => void }) {
                    this.retain();
                    this.release('done');
                }
            });

            await send(handler, { args: [], path: 'releaseEarly', uuid: '12' });

            expect(postMessageSpy).toHaveBeenCalledWith(
                { result: 'done', uuid: '12' },
                []
            );
        });

        it('context.release() is idempotent', async () => {
            let handler = await setup({
                doubleRelease: function (this: { release: (result?: unknown) => void; retain: (fn?: () => void) => void }) {
                    this.retain();
                    this.release('first');
                    this.release('second');
                }
            });

            await send(handler, { args: [], path: 'doubleRelease', uuid: '13' });

            // retained:true is sent because retain() was called, but release() also fires
            // Only one release postMessage should happen
            let releaseCalls = postMessageSpy.mock.calls.filter(
                (call: unknown[]) => (call[0] as Record<string, unknown>).result === 'first'
            );

            expect(releaseCalls).toHaveLength(1);

            let secondCalls = postMessageSpy.mock.calls.filter(
                (call: unknown[]) => (call[0] as Record<string, unknown>).result === 'second'
            );

            expect(secondCalls).toHaveLength(0);
        });

        it('pool release without cleanup handler sends undefined result', async () => {
            let handler = await setup({ fn: () => 1 });

            // Send release for uuid with no retained cleanup
            await send(handler, { release: true, uuid: '14' });

            expect(postMessageSpy).toHaveBeenCalledWith(
                { result: undefined, uuid: '14' }
            );
        });

        it('retain without cleanup fn does not store cleanup', async () => {
            let handler = await setup({
                hold: function (this: { retain: (fn?: () => void) => void }) {
                    this.retain();
                }
            });

            await send(handler, { args: [], path: 'hold', uuid: '15' });
            await send(handler, { release: true, uuid: '15' });

            // Should send undefined since no cleanup was stored (cleanup was undefined, so not set in map)
            expect(postMessageSpy).toHaveBeenCalledWith(
                { result: undefined, uuid: '15' }
            );
        });
    });


    describe('context.dispatch', () => {
        it('sends event and data back via postMessage', async () => {
            let handler = await setup({
                emitter: function (this: { dispatch: (event: string, data: unknown) => void }) {
                    this.dispatch('progress', { percent: 50 });
                }
            });

            await send(handler, { args: [], path: 'emitter', uuid: '16' });

            expect(postMessageSpy).toHaveBeenCalledWith(
                { data: { percent: 50 }, event: 'progress', uuid: '16' },
                []
            );
        });
    });


    describe('heartbeat', () => {
        it('starts sending heartbeat messages when heartbeat config is present', async () => {
            let handler = await setup({
                slow: async function (this: unknown) {
                    await new Promise((r) => setTimeout(r, 500));
                    return 'done';
                }
            });

            vi.useFakeTimers();

            // Do not await — the action is async and takes 500ms
            handler({ data: { args: [], heartbeat: true, heartbeatInterval: 100, path: 'slow', uuid: 'hb-1' } });

            // Advance time to trigger heartbeat intervals
            vi.advanceTimersByTime(100);

            let heartbeatCalls = postMessageSpy.mock.calls.filter(
                (call: unknown[]) => (call[0] as Record<string, unknown>).heartbeat === true
            );

            expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);
            expect(heartbeatCalls[0][0]).toEqual({ heartbeat: true, uuid: 'hb-1' });

            // Advance more to get more heartbeats
            vi.advanceTimersByTime(200);

            let heartbeatCalls2 = postMessageSpy.mock.calls.filter(
                (call: unknown[]) => (call[0] as Record<string, unknown>).heartbeat === true
            );

            expect(heartbeatCalls2.length).toBeGreaterThanOrEqual(3);

            // Complete the task by advancing past the setTimeout
            await vi.advanceTimersByTimeAsync(200);
        });

        it('stops heartbeat after task completes synchronously', async () => {
            let handler = await setup({
                fast: function (this: unknown) { return 'quick'; }
            });

            // Call synchronously — synchronous action completes immediately
            await handler({ data: { args: [], heartbeat: true, heartbeatInterval: 50, path: 'fast', uuid: 'hb-2' } });

            // Allow microtasks
            await new Promise((r) => setTimeout(r, 0));

            postMessageSpy.mockClear();

            vi.useFakeTimers();

            // Advance time — no more heartbeats should fire since task is complete
            vi.advanceTimersByTime(200);

            let heartbeatCalls = postMessageSpy.mock.calls.filter(
                (call: unknown[]) => (call[0] as Record<string, unknown>).heartbeat === true
            );

            expect(heartbeatCalls.length).toBe(0);
        });

        it('stops heartbeat after task throws', async () => {
            let handler = await setup({
                boom: function (this: unknown) { throw new Error('fail'); }
            });

            await handler({ data: { args: [], heartbeat: true, heartbeatInterval: 50, path: 'boom', uuid: 'hb-3' } });
            await new Promise((r) => setTimeout(r, 0));

            postMessageSpy.mockClear();

            vi.useFakeTimers();

            vi.advanceTimersByTime(200);

            let heartbeatCalls = postMessageSpy.mock.calls.filter(
                (call: unknown[]) => (call[0] as Record<string, unknown>).heartbeat === true
            );

            expect(heartbeatCalls.length).toBe(0);
        });

        it('does not start heartbeat without heartbeat config', async () => {
            let handler = await setup({
                normal: function (this: unknown) { return 1; }
            });

            await send(handler, { args: [], path: 'normal', uuid: 'hb-4' });

            vi.useFakeTimers();

            vi.advanceTimersByTime(500);

            let heartbeatCalls = postMessageSpy.mock.calls.filter(
                (call: unknown[]) => (call[0] as Record<string, unknown>).heartbeat === true
            );

            expect(heartbeatCalls.length).toBe(0);
        });

        it('clears heartbeat when action path does not exist', async () => {
            let handler = await setup({ fn: () => 1 });

            await handler({ data: { args: [], heartbeat: true, heartbeatInterval: 50, path: 'nonexistent', uuid: 'hb-5' } });
            await new Promise((r) => setTimeout(r, 0));

            postMessageSpy.mockClear();

            vi.useFakeTimers();

            vi.advanceTimersByTime(200);

            let heartbeatCalls = postMessageSpy.mock.calls.filter(
                (call: unknown[]) => (call[0] as Record<string, unknown>).heartbeat === true
            );

            expect(heartbeatCalls.length).toBe(0);
        });
    });


    describe('error handling', () => {
        it('sends error object with message and stack when action throws Error', async () => {
            let handler = await setup({
                fail: function (this: unknown) { throw new Error('boom'); }
            });

            await send(handler, { args: [], path: 'fail', uuid: '17' });

            let call = postMessageSpy.mock.calls.find(
                (c: unknown[]) => (c[0] as Record<string, unknown>).error
            );

            expect(call).toBeDefined();
            expect((call![0] as Record<string, unknown>).error).toEqual(
                expect.objectContaining({ message: 'boom' })
            );
            expect((call![0] as Record<string, unknown>).uuid).toBe('17');
        });

        it('sends stringified error when action throws non-Error', async () => {
            let handler = await setup({
                fail: function (this: unknown) { throw 'string-error'; }
            });

            await send(handler, { args: [], path: 'fail', uuid: '18' });

            expect(postMessageSpy).toHaveBeenCalledWith(
                { error: 'string-error', uuid: '18' }
            );
        });

        it('sends error when release cleanup throws Error', async () => {
            let handler = await setup({
                hold: function (this: { retain: (fn?: () => void) => void }) {
                    this.retain(() => { throw new Error('cleanup-fail'); });
                }
            });

            await send(handler, { args: [], path: 'hold', uuid: '19' });
            postMessageSpy.mockClear();

            await send(handler, { release: true, uuid: '19' });

            let call = postMessageSpy.mock.calls[0];

            expect((call[0] as Record<string, unknown>).error).toEqual(
                expect.objectContaining({ message: 'cleanup-fail' })
            );
            expect((call[0] as Record<string, unknown>).uuid).toBe('19');
        });

        it('sends stringified error when release cleanup throws non-Error', async () => {
            let handler = await setup({
                hold: function (this: { retain: (fn?: () => void) => void }) {
                    this.retain(() => { throw 42; });
                }
            });

            await send(handler, { args: [], path: 'hold', uuid: '20' });
            postMessageSpy.mockClear();

            await send(handler, { release: true, uuid: '20' });

            expect(postMessageSpy).toHaveBeenCalledWith(
                { error: '42', uuid: '20' }
            );
        });
    });


    describe('action throws after calling retain()', () => {
        it('sends error and does not store cleanup in cleanups map', async () => {
            let cleanupSpy = vi.fn(() => 'cleaned-up'),
                handler = await setup({
                    retainThenThrow: function (this: { retain: (fn?: () => void) => void }) {
                        this.retain(cleanupSpy);
                        throw new Error('action-failed');
                    }
                });

            await send(handler, { args: [], path: 'retainThenThrow', uuid: 'rt-1' });

            // Error should be sent back
            let errorCall = postMessageSpy.mock.calls.find(
                (c: unknown[]) => (c[0] as Record<string, unknown>).error
            );

            expect(errorCall).toBeDefined();
            expect((errorCall![0] as Record<string, unknown>).error).toEqual(
                expect.objectContaining({ message: 'action-failed' })
            );

            // No retained message should have been sent
            let retainedCalls = postMessageSpy.mock.calls.filter(
                (c: unknown[]) => (c[0] as Record<string, unknown>).retained === true
            );

            expect(retainedCalls).toHaveLength(0);
        });

        it('subsequent release sends undefined because cleanup was never stored', async () => {
            let cleanupSpy = vi.fn(() => 'cleaned-up'),
                handler = await setup({
                    retainThenThrow: function (this: { retain: (fn?: () => void) => void }) {
                        this.retain(cleanupSpy);
                        throw new Error('action-failed');
                    }
                });

            await send(handler, { args: [], path: 'retainThenThrow', uuid: 'rt-2' });
            postMessageSpy.mockClear();

            // Send release from pool — cleanup was never stored in the map
            await send(handler, { release: true, uuid: 'rt-2' });

            expect(cleanupSpy).not.toHaveBeenCalled();
            expect(postMessageSpy).toHaveBeenCalledWith(
                { result: undefined, uuid: 'rt-2' }
            );
        });
    });


    describe('release() called without prior retain()', () => {
        it('sends two result messages — one from release and one from normal completion', async () => {
            let handler = await setup({
                releaseWithoutRetain: function (this: { release: (result?: unknown) => void }) {
                    this.release('early-result');
                    return 'normal-result';
                }
            });

            await send(handler, { args: [], path: 'releaseWithoutRetain', uuid: 'rwr-1' });

            // release() posts { result: 'early-result', uuid }
            expect(postMessageSpy).toHaveBeenCalledWith(
                { result: 'early-result', uuid: 'rwr-1' },
                []
            );

            // Normal completion posts { result: 'normal-result', uuid } because retained is false
            expect(postMessageSpy).toHaveBeenCalledWith(
                { result: 'normal-result', uuid: 'rwr-1' },
                []
            );

            // Two result-bearing calls total
            let resultCalls = postMessageSpy.mock.calls.filter(
                (c: unknown[]) => 'result' in (c[0] as Record<string, unknown>)
            );

            expect(resultCalls).toHaveLength(2);
        });

        it('does not crash when release is called without retain', async () => {
            let handler = await setup({
                releaseOnly: function (this: { release: (result?: unknown) => void }) {
                    this.release();
                }
            });

            await send(handler, { args: [], path: 'releaseOnly', uuid: 'rwr-2' });

            // Should not throw — both release() and normal path send messages
            let resultCalls = postMessageSpy.mock.calls.filter(
                (c: unknown[]) => 'result' in (c[0] as Record<string, unknown>)
            );

            expect(resultCalls).toHaveLength(2);
        });
    });


    describe('adapter()', () => {
        it('throws when neither self nor parentPort is available', async () => {
            vi.stubGlobal('self', undefined);

            await expect(setup({ fn: () => 1 })).rejects.toThrow(
                '@esportsplus/workers: must be called from within a worker context'
            );
        });
    });
});
