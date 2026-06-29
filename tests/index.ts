import { priority as prioritySchedule } from '../src/schedule';
import { describe, expect, test } from 'vitest';

import workers, { onmessage, pool, priority } from '../src/index';
import onmessageDefault from '../src/onmessage';
import poolDefault from '../src/pool';


describe('barrel (src/index.ts)', () => {
    describe('default export', () => {
        test('is defined', () => {
            expect(workers).toBeDefined();
        });

        test('exposes onmessage binding', () => {
            expect(workers.onmessage).toBeDefined();
            expect(typeof workers.onmessage).toBe('function');
        });

        test('exposes pool binding', () => {
            expect(workers.pool).toBeDefined();
            expect(typeof workers.pool).toBe('function');
        });

        test('exposes priority binding', () => {
            expect(workers.priority).toBeDefined();
            expect(typeof workers.priority).toBe('function');
        });

        test('pool property is identical to src/pool default', () => {
            expect(workers.pool).toBe(poolDefault);
        });

        test('onmessage property is identical to src/onmessage default', () => {
            expect(workers.onmessage).toBe(onmessageDefault);
        });

        test('priority property is identical to src/schedule priority', () => {
            expect(workers.priority).toBe(prioritySchedule);
        });
    });


    describe('named exports', () => {
        test('pool is defined and is a function', () => {
            expect(pool).toBeDefined();
            expect(typeof pool).toBe('function');
        });

        test('onmessage is defined and is a function', () => {
            expect(onmessage).toBeDefined();
            expect(typeof onmessage).toBe('function');
        });

        test('priority is defined and is a function', () => {
            expect(priority).toBeDefined();
            expect(typeof priority).toBe('function');
        });

        test('named pool is identical to src/pool default', () => {
            expect(pool).toBe(poolDefault);
        });

        test('named onmessage is identical to src/onmessage default', () => {
            expect(onmessage).toBe(onmessageDefault);
        });

        test('named priority is identical to src/schedule priority', () => {
            expect(priority).toBe(prioritySchedule);
        });

        test('named pool is identical to default export pool property', () => {
            expect(pool).toBe(workers.pool);
        });

        test('named onmessage is identical to default export onmessage property', () => {
            expect(onmessage).toBe(workers.onmessage);
        });

        test('named priority is identical to default export priority property', () => {
            expect(priority).toBe(workers.priority);
        });
    });
});
