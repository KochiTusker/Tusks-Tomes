import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Inline both VITE_* and PAID_* env vars into the browser bundle.
  // PAID_GEMINI_API_KEY is matched by the second prefix.
  envPrefix: ['VITE_', 'PAID_'],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: 'node',
    // Vitest's default is 5s, which is generous for a pure function and tight
    // for the shape a lot of this suite has: `vi.resetModules()` plus a
    // dynamic import that rebuilds a server module graph, or an Express app
    // bound to an ephemeral port. Those run in about a second alone and are
    // several times slower when ~140 files are competing for the same cores.
    //
    // The failure mode is what makes this worth configuring rather than
    // patching per test: they pass locally, pass in isolation, and time out
    // in whichever run happens to be unlucky — so the signal reads as "flaky
    // suite" and gets ignored, which is the expensive outcome. Two tests had
    // already been given individual timeouts for exactly this before it was
    // recognised as one problem.
    //
    // 20s is chosen to absorb contention, not to accommodate slow tests. A
    // genuinely hung test still fails, 15s later than before; a test that
    // needs more than this on an idle machine is too slow and should say so
    // with an explicit per-test timeout and a comment explaining why (see
    // scripts/audit-dangerous-fs-rm.test.mjs, which reads every source file).
    testTimeout: 20_000,
    // Setup/teardown gets the same treatment — a beforeEach that mkdtemps and
    // remocks is subject to identical contention, and a hook timing out
    // reports as a confusing failure in whichever test happened to be next.
    hookTimeout: 20_000,
    // jsdom is opt-in per file with a top-of-file pragma:
    //   // @vitest-environment jsdom
    // Use it for component tests under src/**/*.test.tsx. Everything
    // else stays on `node` — faster startup, no DOM pollution.
    setupFiles: ['./src/test-setup.ts'],
    // The scripts/ glob picks up the .mjs suites under scripts/, which
    // cover behaviour with no TypeScript entry point of its own, so they
    // must run on every push.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'server/**/*.test.ts',
      'scripts/**/*.test.mjs',
      // The chronicle bake-off lives here. It is gated behind TUSK_BAKEOFF=1
      // and skips itself in an ordinary run — it spends real money and needs a
      // real transcript — but it has to be discoverable to be runnable at all.
      'scripts/**/*.bakeoff.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      // Standalone runner with a shebang — invoked by `node` directly
      // (npm run uninstall:test), not loaded through vitest's esbuild
      // transform which chokes on the #! line.
      'scripts/uninstall.test.mjs',
    ],
  },
})
