import { describe, it, expect } from "vitest";
import { ReadinessState } from "./readiness.js";

describe("ReadinessState (§19 drain-aware readiness)", () => {
  it("starts ready so the load balancer routes to a fresh replica", () => {
    const readiness = new ReadinessState();
    expect(readiness.isReady()).toBe(true);
    expect(readiness.status()).toBe("ready");
  });

  it("flips to not-ready once draining begins so the LB drains this replica", () => {
    const readiness = new ReadinessState();
    readiness.beginDraining();
    expect(readiness.isReady()).toBe(false);
    expect(readiness.status()).toBe("draining");
  });

  it("is idempotent: draining again keeps it not-ready", () => {
    const readiness = new ReadinessState();
    readiness.beginDraining();
    readiness.beginDraining();
    expect(readiness.isReady()).toBe(false);
  });
});
