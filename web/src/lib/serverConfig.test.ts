import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearServerBaseUrl,
  getServerBaseUrl,
  hasExplicitServerUrl,
  isServerConfigured,
  loadServerBaseUrl,
  normalizeBase,
  setServerBaseUrl,
} from "./serverConfig";

beforeEach(async () => {
  // Fresh IndexedDB per test, then reset the in-memory cache from it.
  globalThis.indexedDB = new IDBFactory();
  await loadServerBaseUrl();
});

describe("normalizeBase", () => {
  it("trims whitespace and strips trailing slashes", () => {
    expect(normalizeBase("  http://host:8000/  ")).toBe("http://host:8000");
    expect(normalizeBase("http://host:8000///")).toBe("http://host:8000");
  });
});

describe("server base url persistence", () => {
  it("defaults to the node fallback when nothing is configured", () => {
    // No window and not native → the module's non-browser default.
    expect(getServerBaseUrl()).toBe("http://localhost:8000");
    expect(hasExplicitServerUrl()).toBe(false);
  });

  it("persists an explicit URL and reloads it into the cache", async () => {
    await setServerBaseUrl("http://192.168.1.20:8000/");
    expect(getServerBaseUrl()).toBe("http://192.168.1.20:8000");
    expect(hasExplicitServerUrl()).toBe(true);
    expect(isServerConfigured()).toBe(true);

    // Simulate a cold start: reload purely from storage.
    await loadServerBaseUrl();
    expect(getServerBaseUrl()).toBe("http://192.168.1.20:8000");
  });

  it("rejects an empty or malformed URL", async () => {
    await expect(setServerBaseUrl("   ")).rejects.toThrow();
    await expect(setServerBaseUrl("not a url")).rejects.toThrow();
    await expect(setServerBaseUrl("ftp://host")).rejects.toThrow();
  });

  it("clears an explicit URL back to the default", async () => {
    await setServerBaseUrl("http://host:9000");
    await clearServerBaseUrl();
    expect(hasExplicitServerUrl()).toBe(false);
    expect(getServerBaseUrl()).toBe("http://localhost:8000");
  });
});
