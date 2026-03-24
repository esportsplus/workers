import { defineConfig } from 'vitest/config';
import { resolve } from 'path';


export default defineConfig({
    resolve: {
        alias: {
            '~': resolve(__dirname, 'src')
        }
    },
    test: {
        include: ['tests/**/*.ts'],
        restoreMocks: true
    }
});
