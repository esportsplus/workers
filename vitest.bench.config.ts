import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';


export default defineConfig({
    resolve: {
        alias: {
            '~': resolve(import.meta.dirname!, 'src'),
        },
    },
    test: {
        benchmark: {
            include: ['test/bench/**/*.bench.ts'],
        },
        pool: 'forks',
    },
});
