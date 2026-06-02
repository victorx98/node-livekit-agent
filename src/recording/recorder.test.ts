import { describe, it, expect, vi } from "vitest";
import { Recorder, type EgressGateway, type RecorderPlan } from "./recorder.js";

const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeGateway(
  overrides: Partial<EgressGateway> = {},
): EgressGateway & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  return {
    start: vi.fn(async () => "egr_abc"),
    stop: vi.fn(async () => {}),
    ...overrides,
  } as EgressGateway & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
}

function makeRecorder(
  plan: Partial<RecorderPlan>,
  opts: { preflight?: () => Promise<void>; gateway?: ReturnType<typeof fakeGateway> } = {},
) {
  const gateway = opts.gateway ?? fakeGateway();
  const preflight = vi.fn(opts.preflight ?? (async () => {}));
  const recorder = new Recorder({
    plan: {
      enabled: true,
      required: false,
      filepath: "interviews/int_789/job_123.mp4",
      audioOnly: false,
      ...plan,
    },
    roomName: "room_1",
    preflight,
    gateway,
    log: noopLog,
  });
  return { recorder, gateway, preflight };
}

describe("Recorder.start — recording lifecycle + required-vs-degrade policy (§16)", () => {
  it("preflights then starts egress and reports active with the egress id", async () => {
    const { recorder, gateway, preflight } = makeRecorder({ audioOnly: true });

    const result = await recorder.start();

    expect(result).toEqual({ status: "active", egressId: "egr_abc" });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(gateway.start).toHaveBeenCalledWith("room_1", "interviews/int_789/job_123.mp4", true);
  });

  it("reports disabled and touches nothing when recording is not enabled", async () => {
    const { recorder, gateway, preflight } = makeRecorder({ enabled: false });

    const result = await recorder.start();

    expect(result).toEqual({ status: "disabled" });
    expect(preflight).not.toHaveBeenCalled();
    expect(gateway.start).not.toHaveBeenCalled();
  });

  it("fails the job when the S3 preflight fails and recording is required", async () => {
    const { recorder, gateway } = makeRecorder(
      { required: true },
      {
        preflight: async () => {
          throw new Error("HeadBucket denied");
        },
      },
    );

    await expect(recorder.start()).rejects.toThrow(/HeadBucket denied/);
    expect(gateway.start).not.toHaveBeenCalled();
  });

  it("degrades to failed (and continues) when preflight fails but recording is not required", async () => {
    const { recorder, gateway } = makeRecorder(
      { required: false },
      {
        preflight: async () => {
          throw new Error("HeadBucket denied");
        },
      },
    );

    const result = await recorder.start();

    expect(result).toEqual({ status: "failed" });
    expect(gateway.start).not.toHaveBeenCalled();
  });

  it("fails the job when egress start fails and recording is required", async () => {
    const gateway = fakeGateway({
      start: vi.fn(async () => {
        throw new Error("egress unavailable");
      }),
    });
    const { recorder } = makeRecorder({ required: true }, { gateway });

    await expect(recorder.start()).rejects.toThrow(/egress unavailable/);
  });

  it("degrades to failed when egress start fails but recording is not required", async () => {
    const gateway = fakeGateway({
      start: vi.fn(async () => {
        throw new Error("egress unavailable");
      }),
    });
    const { recorder } = makeRecorder({ required: false }, { gateway });

    const result = await recorder.start();

    expect(result).toEqual({ status: "failed" });
  });
});

describe("Recorder.stop — safe stop (§16: ignore already-stopped)", () => {
  it("stops the egress by id", async () => {
    const { recorder, gateway } = makeRecorder({});

    await recorder.stop("egr_abc");

    expect(gateway.stop).toHaveBeenCalledWith("egr_abc");
  });

  it("never throws when the egress was already stopped", async () => {
    const gateway = fakeGateway({
      stop: vi.fn(async () => {
        throw new Error("egress already ended");
      }),
    });
    const { recorder } = makeRecorder({}, { gateway });

    await expect(recorder.stop("egr_abc")).resolves.toBeUndefined();
    expect(noopLog.warn).toHaveBeenCalled();
  });
});
