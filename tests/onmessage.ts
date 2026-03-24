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
});
