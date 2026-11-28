import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 45_000,
    hookTimeout: 60_000,
    // Integration files share one API + database but each uses its own mail user, so they can run in parallel.
    fileParallelism: true,
    maxWorkers: 4, // more parallel files make the timing-based tests (background sync cadence) flaky
  },
});
