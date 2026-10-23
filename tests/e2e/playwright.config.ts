import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
});
