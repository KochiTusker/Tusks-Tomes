// Vitest setup file. Loaded once per test process (per vite.config.ts
// `setupFiles`). Adds the @testing-library/jest-dom custom matchers
// (.toBeInTheDocument, .toHaveTextContent, etc.) to vitest's expect
// — used by jsdom-based component tests under src/**/*.test.tsx.
//
// Non-component tests (node environment, no DOM) load this file too but
// don't use the matchers. The import has no side effects beyond
// extending expect, so it's safe across both environments.
import '@testing-library/jest-dom/vitest'
