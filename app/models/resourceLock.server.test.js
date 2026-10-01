import { describe, it, expect, vi } from "vitest";

const query = vi.fn().mockResolvedValue([[{ acquired: 1 }]]);
const release = vi.fn();
vi.mock("mysql2/promise", () => ({
  default: {
    createPool: () => ({ getConnection: vi.fn().mockResolvedValue({ query, release }) }),
  },
}));

const { withResourceLock, resourceLockKey } = await import("./resourceLock.server");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("withResourceLock", () => {
  it("runs work for the same key one at a time", async () => {
    const events = [];
    const key = resourceLockKey(1, "order", "gid://shopify/Order/1");
    const job = (name) =>
      withResourceLock(key, async () => {
        events.push(`start:${name}`);
        await tick();
        events.push(`end:${name}`);
        return name;
      });

    const results = await Promise.all([job("a"), job("b"), job("c")]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    expect(query).toHaveBeenCalledWith("SELECT GET_LOCK(?, ?) AS acquired", [key, 30]);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("lets different keys run concurrently", async () => {
    const events = [];
    const job = (key) =>
      withResourceLock(key, async () => {
        events.push(`start:${key}`);
        await tick();
        events.push(`end:${key}`);
      });

    await Promise.all([job("zb:1:order:a"), job("zb:1:order:b")]);

    expect(events.slice(0, 2)).toEqual(["start:zb:1:order:a", "start:zb:1:order:b"]);
  });

  it("releases the lock when the work throws", async () => {
    const key = "zb:1:order:throws";
    await expect(withResourceLock(key, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withResourceLock(key, async () => "next")).resolves.toBe("next");
  });
});
