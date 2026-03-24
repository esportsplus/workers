import { describe, expect, it } from 'vitest';
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
