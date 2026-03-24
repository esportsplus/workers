import { describe, expect, it, vi } from 'vitest';

import { TaskPromise } from '../src/task';


describe('TaskPromise', () => {

    describe('basics', () => {
        it('resolves like a normal Promise', async () => {
            let task = new TaskPromise((resolve) => resolve('ok'));

            await expect(task).resolves.toBe('ok');
        });

        it('rejects like a normal Promise', async () => {
            let task = new TaskPromise((_, reject) => reject(new Error('fail')));

            await expect(task).rejects.toThrow('fail');
        });

        it('can be awaited', async () => {
            let task = new TaskPromise((resolve) => resolve(42));
            let result = await task;

            expect(result).toBe(42);
        });
    });


    describe('Symbol.species', () => {
        it('.then() returns a plain Promise, not TaskPromise', () => {
            let task = new TaskPromise((resolve) => resolve('ok'));
            let chained = task.then((v) => v);

            expect(chained).toBeInstanceOf(Promise);
            expect(chained).not.toBeInstanceOf(TaskPromise);
        });

        it('.catch() returns a plain Promise, not TaskPromise', async () => {
            let task = new TaskPromise((_, reject) => reject(new Error('fail')));
            let chained = task.catch(() => 'recovered');

            expect(chained).toBeInstanceOf(Promise);
            expect(chained).not.toBeInstanceOf(TaskPromise);

            await expect(chained).resolves.toBe('recovered');
        });
    });


    describe('.on()', () => {
        it('registers a handler and returns this (chainable)', () => {
            let task = new TaskPromise((resolve) => resolve('ok'));
            let result = task.on('test', () => {});

            expect(result).toBe(task);
        });

        it('multiple .on() calls chain correctly', () => {
            let task = new TaskPromise((resolve) => resolve('ok'));
            let result = task
                .on('a', () => {})
                .on('b', () => {})
                .on('c', () => {});

            expect(result).toBe(task);
        });

        it('multiple handlers for same event', () => {
            let handler1 = vi.fn(),
                handler2 = vi.fn(),
                task = new TaskPromise<string, { ping: number }>((resolve) => resolve('ok'));

            task.on('ping', handler1).on('ping', handler2);
            task.dispatch('ping', 99);

            expect(handler1).toHaveBeenCalledWith(99);
            expect(handler2).toHaveBeenCalledWith(99);
        });
    });


    describe('.dispatch()', () => {
        it('calls registered handler with correct data', () => {
            let handler = vi.fn(),
                task = new TaskPromise<string, { data: { value: number } }>((resolve) => resolve('ok'));

            task.on('data', handler);
            task.dispatch('data', { value: 42 });

            expect(handler).toHaveBeenCalledOnce();
            expect(handler).toHaveBeenCalledWith({ value: 42 });
        });

        it('calls multiple handlers for same event', () => {
            let handler1 = vi.fn(),
                handler2 = vi.fn(),
                handler3 = vi.fn(),
                task = new TaskPromise<string, { msg: string }>((resolve) => resolve('ok'));

            task.on('msg', handler1).on('msg', handler2).on('msg', handler3);
            task.dispatch('msg', 'hello');

            expect(handler1).toHaveBeenCalledWith('hello');
            expect(handler2).toHaveBeenCalledWith('hello');
            expect(handler3).toHaveBeenCalledWith('hello');
        });

        it('no-op when no listeners registered', () => {
            let task = new TaskPromise((resolve) => resolve('ok'));

            expect(() => task.dispatch('anything')).not.toThrow();
        });

        it('no-op for unregistered event name', () => {
            let handler = vi.fn(),
                task = new TaskPromise<string, { known: string }>((resolve) => resolve('ok'));

            task.on('known', handler);
            task.dispatch('unknown');

            expect(handler).not.toHaveBeenCalled();
        });

        it('dispatches release event', () => {
            let handler = vi.fn(),
                task = new TaskPromise<string, { release: undefined }>((resolve) => resolve('ok'));

            task.on('release', handler);
            task.dispatch('release');

            expect(handler).toHaveBeenCalledOnce();
        });
    });
});
