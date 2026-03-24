import { afterEach, describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';

import { collectTransferables } from '../src/transfer';


describe('collectTransferables', () => {

    describe('primitives', () => {
        it('returns empty array for null', () => {
            expect(collectTransferables(null)).toEqual([]);
        });

        it('returns empty array for undefined', () => {
            expect(collectTransferables(undefined)).toEqual([]);
        });

        it('returns empty array for number', () => {
            expect(collectTransferables(42)).toEqual([]);
        });

        it('returns empty array for string', () => {
            expect(collectTransferables('hello')).toEqual([]);
        });

        it('returns empty array for boolean', () => {
            expect(collectTransferables(true)).toEqual([]);
        });
    });


    describe('ArrayBuffer detection', () => {
        it('detects single ArrayBuffer', () => {
            let buffer = new ArrayBuffer(8);
            let result = collectTransferables(buffer);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(buffer);
        });

        it('detects ArrayBuffer nested in object', () => {
            let buffer = new ArrayBuffer(8);
            let result = collectTransferables({ data: buffer });

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(buffer);
        });

        it('detects ArrayBuffer nested in array', () => {
            let buffer = new ArrayBuffer(8);
            let result = collectTransferables([buffer]);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(buffer);
        });

        it('detects multiple ArrayBuffers at different nesting levels', () => {
            let a = new ArrayBuffer(4),
                b = new ArrayBuffer(8),
                c = new ArrayBuffer(16);

            let result = collectTransferables({
                buffer: a,
                nested: {
                    buffer: b,
                    deeper: [c]
                }
            });

            expect(result).toHaveLength(3);
            expect(result).toContain(a);
            expect(result).toContain(b);
            expect(result).toContain(c);
        });
    });


    describe('MessagePort detection', () => {
        it('detects MessagePort', () => {
            let channel = new MessageChannel(),
                port = channel.port1;

            let result = collectTransferables({ port });

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(port);

            channel.port1.close();
            channel.port2.close();
        });
    });


    describe('nested structures', () => {
        it('traverses deeply nested objects', () => {
            let buffer = new ArrayBuffer(8);
            let result = collectTransferables({
                a: { b: { c: { d: { e: buffer } } } }
            });

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(buffer);
        });

        it('traverses arrays of objects containing transferables', () => {
            let a = new ArrayBuffer(4),
                b = new ArrayBuffer(8);

            let result = collectTransferables([
                { buffer: a },
                { buffer: b }
            ]);

            expect(result).toHaveLength(2);
            expect(result).toContain(a);
            expect(result).toContain(b);
        });

        it('handles mixed arrays and objects', () => {
            let a = new ArrayBuffer(4),
                b = new ArrayBuffer(8);

            let result = collectTransferables({
                items: [a, { nested: b }]
            });

            expect(result).toHaveLength(2);
            expect(result).toContain(a);
            expect(result).toContain(b);
        });

        it('returns empty array for empty object', () => {
            expect(collectTransferables({})).toEqual([]);
        });

        it('returns empty array for empty array', () => {
            expect(collectTransferables([])).toEqual([]);
        });
    });


    describe('stream detection', () => {
        it('detects ReadableStream', () => {
            let stream = new ReadableStream();
            let result = collectTransferables(stream);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(stream);
        });

        it('detects WritableStream', () => {
            let stream = new WritableStream();
            let result = collectTransferables(stream);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(stream);
        });

        it('detects TransformStream', () => {
            let stream = new TransformStream();
            let result = collectTransferables(stream);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(stream);
        });

        it('detects streams nested in objects', () => {
            let readable = new ReadableStream(),
                writable = new WritableStream();

            let result = collectTransferables({
                input: readable,
                output: writable
            });

            expect(result).toHaveLength(2);
            expect(result).toContain(readable);
            expect(result).toContain(writable);
        });

        it('detects streams mixed with ArrayBuffer', () => {
            let buffer = new ArrayBuffer(8),
                stream = new ReadableStream();

            let result = collectTransferables({
                data: buffer,
                stream
            });

            expect(result).toHaveLength(2);
            expect(result).toContain(buffer);
            expect(result).toContain(stream);
        });
    });


    describe('guarded type detection (mock globals)', () => {
        let originalAudioData = (globalThis as Record<string, unknown>).AudioData,
            originalMediaSourceHandle = (globalThis as Record<string, unknown>).MediaSourceHandle,
            originalRTCDataChannel = (globalThis as Record<string, unknown>).RTCDataChannel,
            originalVideoFrame = (globalThis as Record<string, unknown>).VideoFrame;

        afterEach(() => {
            if (originalAudioData === undefined) {
                delete (globalThis as Record<string, unknown>).AudioData;
            }
            else {
                (globalThis as Record<string, unknown>).AudioData = originalAudioData;
            }

            if (originalMediaSourceHandle === undefined) {
                delete (globalThis as Record<string, unknown>).MediaSourceHandle;
            }
            else {
                (globalThis as Record<string, unknown>).MediaSourceHandle = originalMediaSourceHandle;
            }

            if (originalRTCDataChannel === undefined) {
                delete (globalThis as Record<string, unknown>).RTCDataChannel;
            }
            else {
                (globalThis as Record<string, unknown>).RTCDataChannel = originalRTCDataChannel;
            }

            if (originalVideoFrame === undefined) {
                delete (globalThis as Record<string, unknown>).VideoFrame;
            }
            else {
                (globalThis as Record<string, unknown>).VideoFrame = originalVideoFrame;
            }
        });

        it('detects VideoFrame when available', () => {
            class MockVideoFrame {}

            (globalThis as Record<string, unknown>).VideoFrame = MockVideoFrame;

            let frame = new MockVideoFrame();
            let result = collectTransferables(frame);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(frame);
        });

        it('detects AudioData when available', () => {
            class MockAudioData {}

            (globalThis as Record<string, unknown>).AudioData = MockAudioData;

            let audio = new MockAudioData();
            let result = collectTransferables(audio);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(audio);
        });

        it('detects MediaSourceHandle when available', () => {
            class MockMediaSourceHandle {}

            (globalThis as Record<string, unknown>).MediaSourceHandle = MockMediaSourceHandle;

            let handle = new MockMediaSourceHandle();
            let result = collectTransferables(handle);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(handle);
        });

        it('detects RTCDataChannel when available', () => {
            class MockRTCDataChannel {}

            (globalThis as Record<string, unknown>).RTCDataChannel = MockRTCDataChannel;

            let channel = new MockRTCDataChannel();
            let result = collectTransferables(channel);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(channel);
        });

        it('ignores unavailable types gracefully', () => {
            delete (globalThis as Record<string, unknown>).VideoFrame;
            delete (globalThis as Record<string, unknown>).AudioData;
            delete (globalThis as Record<string, unknown>).MediaSourceHandle;
            delete (globalThis as Record<string, unknown>).RTCDataChannel;

            let buffer = new ArrayBuffer(8);
            let result = collectTransferables({ data: buffer });

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(buffer);
        });

        it('detects multiple guarded types together', () => {
            class MockAudioData {}
            class MockVideoFrame {}

            (globalThis as Record<string, unknown>).AudioData = MockAudioData;
            (globalThis as Record<string, unknown>).VideoFrame = MockVideoFrame;

            let audio = new MockAudioData(),
                buffer = new ArrayBuffer(8),
                stream = new ReadableStream(),
                video = new MockVideoFrame();

            let result = collectTransferables({
                audio,
                buffer,
                nested: { stream, video }
            });

            expect(result).toHaveLength(4);
            expect(result).toContain(audio);
            expect(result).toContain(buffer);
            expect(result).toContain(stream);
            expect(result).toContain(video);
        });

        it('detects WebTransport streams via ReadableStream/WritableStream inheritance', () => {
            class WebTransportReceiveStream extends ReadableStream {}
            class WebTransportSendStream extends WritableStream {}

            let receive = new WebTransportReceiveStream(),
                send = new WebTransportSendStream();

            let result = collectTransferables({ receive, send });

            expect(result).toHaveLength(2);
            expect(result).toContain(receive);
            expect(result).toContain(send);
        });
    });


    describe('edge cases', () => {
        it('handles objects with no transferables', () => {
            let result = collectTransferables({
                name: 'test',
                count: 42,
                active: true,
                nested: { value: 'hello' }
            });

            expect(result).toEqual([]);
        });

        it('handles array with primitives only', () => {
            let result = collectTransferables([1, 'two', true, null, undefined]);

            expect(result).toEqual([]);
        });
    });
});
