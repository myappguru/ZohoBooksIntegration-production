import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installShutdownHandlers } from "./gracefulShutdown.server";

describe("installShutdownHandlers", () => {
  let proc;
  let exit;
  let uninstall;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    proc = new EventEmitter();
    exit = vi.fn();
  });

  afterEach(() => {
    uninstall?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["SIGTERM", "SIGINT"])("exits after the grace period on %s", (signal) => {
    uninstall = installShutdownHandlers({ proc, exit, graceMs: 10_000 });

    proc.emit(signal, signal);
    vi.advanceTimersByTime(9_999);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("stops background work straight away", () => {
    const stopBackgroundWork = vi.fn();
    uninstall = installShutdownHandlers({ proc, exit, stopBackgroundWork });

    proc.emit("SIGTERM", "SIGTERM");

    expect(stopBackgroundWork).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it("still exits if stopping background work throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    uninstall = installShutdownHandlers({
      proc,
      exit,
      graceMs: 1_000,
      stopBackgroundWork: () => {
        throw new Error("boom");
      },
    });

    proc.emit("SIGTERM", "SIGTERM");
    vi.advanceTimersByTime(1_000);

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("only schedules one exit for repeated signals", () => {
    uninstall = installShutdownHandlers({ proc, exit, graceMs: 1_000 });

    proc.emit("SIGTERM", "SIGTERM");
    proc.emit("SIGINT", "SIGINT");
    proc.emit("SIGTERM", "SIGTERM");
    vi.advanceTimersByTime(1_000);

    expect(exit).toHaveBeenCalledTimes(1);
  });
});
