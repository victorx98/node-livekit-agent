import { describe, expect, it, vi } from "vitest";
import { resolveJobConfig } from "./resolveConfig.js";
import { sampleAgentMetadata } from "./sampleMetadata.js";
import type { AgentMetadata } from "../types/job.js";

const JOB_ID = "job_from_context_123";

function resolveSample(mutate?: (metadata: AgentMetadata) => void) {
  const metadata = sampleAgentMetadata();
  mutate?.(metadata);
  return resolveJobConfig(JSON.stringify(metadata), JOB_ID);
}

describe("resolveJobConfig - API-authoritative interview execution", () => {
  it("maps operational identity, provider, duration, recording, and options", () => {
    const cfg = resolveSample();

    expect(cfg).toMatchObject({
      job_id: JOB_ID,
      interview_id: "int_789",
      student_id: "stu_456",
      participant_id: "part_001",
      model_provider: "openai",
      model: "gpt-realtime-2",
      duration_minutes: 60,
      recording: {
        enabled: true,
        key: "livekit-interviews/int_789/job_123.mp4",
      },
      options: {
        autoStart: true,
        enableLogging: true,
      },
    });
  });

  it("preserves the top-level systemInstruction byte-for-byte", () => {
    const instruction = "\n  API-authored instruction with deliberate spacing.  \n";
    const cfg = resolveSample((metadata) => {
      metadata.systemInstruction = instruction;
      metadata.interviewData.systemInstruction = "INNER";
    });

    expect(cfg.system_instruction).toBe(instruction);
    expect(cfg.recovery_snapshot.system_instruction).toBe(instruction);
  });

  it("falls back to the nested instruction and preserves it byte-for-byte", () => {
    const instruction = "\nNested API instruction\n";
    const cfg = resolveSample((metadata) => {
      metadata.systemInstruction = "   ";
      metadata.interviewData.systemInstruction = instruction;
    });

    expect(cfg.system_instruction).toBe(instruction);
  });

  it("fails before runtime startup when no usable instruction exists", () => {
    expect(() =>
      resolveSample((metadata) => {
        metadata.systemInstruction = "";
        metadata.interviewData.systemInstruction = " \n ";
      }),
    ).toThrow(/non-empty systemInstruction/i);
  });

  it("does not transform instructions when interview intelligence fields change", () => {
    const instruction = "Use only this API-authored interview plan.";
    const first = resolveSample((metadata) => {
      metadata.systemInstruction = instruction;
    });
    const second = resolveSample((metadata) => {
      metadata.systemInstruction = instruction;
      metadata.interviewData.language = "Chinese";
      metadata.interviewData.position = "Completely Different Role";
      metadata.interviewData.company = "Different Company";
      metadata.interviewData.interview_questions = [
        { question_text: "A replacement recovery-only question" },
      ];
      metadata.interviewData.student.name = "Different Candidate";
    });

    expect(first.system_instruction).toBe(instruction);
    expect(second.system_instruction).toBe(instruction);
  });

  it("creates an immutable recovery snapshot without email or status fields", () => {
    const cfg = resolveSample();
    const snapshot = cfg.recovery_snapshot;

    expect(snapshot).toEqual({
      system_instruction: "You are a professional technical interviewer...",
      questions: [
        {
          question_text: "Tell me about your backend experience.",
          purpose_and_focus: "Warm-up; gauge depth.",
          sub_points: ["scale", "ownership"],
          category: "background",
        },
        {
          question_text: "How would you debug a production latency issue?",
          category: "problem-solving",
        },
      ],
      language: "en-US",
      interview_type: "technical",
      position: "Node.js Backend Engineer",
      company: "MentorX",
      duration_minutes: 60,
      candidate: {
        name: "Jordan Lee",
        background: "CS senior, 2 internships",
        experience_level: "entry",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("jordan@example.com");
    expect(JSON.stringify(snapshot)).not.toContain("scheduled");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.questions)).toBe(true);
    expect(Object.isFrozen(snapshot.candidate)).toBe(true);
  });

  it("preserves additional question fields in the recovery snapshot", () => {
    const cfg = resolveSample((metadata) => {
      metadata.interviewData.interview_questions = [
        {
          question_text: "Describe the result.",
          expected_answer_time_minutes: 2,
          expected_answer_words: 260,
        },
      ];
    });

    expect(cfg.recovery_snapshot.questions[0]).toMatchObject({
      question_text: "Describe the result.",
      expected_answer_time_minutes: 2,
      expected_answer_words: 260,
    });
  });

  it("supports Python greeting aliases and the Python default", () => {
    expect(resolveSample().greeting_prompt).toBe(
      "Please greet the candidate and begin the interview.",
    );

    const cfg = resolveJobConfig(
      {
        ...sampleAgentMetadata(),
        greeting_prompt: "Begin with the API-provided welcome.",
        greetingPrompt: undefined,
      },
      JOB_ID,
    );
    expect(cfg.greeting_prompt).toBe("Begin with the API-provided welcome.");
  });

  it.each([
    ["openai", "openai"],
    ["OPENAI", "openai"],
    ["google", "google"],
    ["Gemini", "google"],
  ])("normalizes provider %s to %s", (provider, expected) => {
    const cfg = resolveSample((metadata) => {
      metadata.interviewData.model_provider = provider;
    });
    expect(cfg.model_provider).toBe(expected);
  });

  it("accepts snake_case metadata while retaining the authoritative instruction", () => {
    const sample = sampleAgentMetadata();
    const cfg = resolveJobConfig(
      {
        interview_id: sample.interviewId,
        interview_data: {
          ...sample.interviewData,
          model_provider: undefined,
          modelProvider: "Gemini",
          systemInstruction: "",
        },
        student_id: null,
        participant_id: "snake-participant",
        participant_info: sample.participantInfo,
        system_instruction: "snake instruction",
        recording_key: "snake/path.mp4",
        options: { autoStart: false, enableLogging: false, enableRecording: true },
      },
      JOB_ID,
    );

    expect(cfg.system_instruction).toBe("snake instruction");
    expect(cfg.model_provider).toBe("google");
    expect(cfg.recording.key).toBe("snake/path.mp4");
    expect(cfg.options.autoStart).toBe(false);
  });

  it("accepts JSON-stringified interview_data and Python-style question strings", () => {
    const cfg = resolveJobConfig(
      {
        interview_id: "json-inner",
        system_instruction: "Interview exactly as specified here.",
        interview_data: JSON.stringify({
          job_title: "Platform Engineer",
          questions: ["How do you debug latency?"],
          modelProvider: "openai",
        }),
      },
      JOB_ID,
    );

    expect(cfg.system_instruction).toBe("Interview exactly as specified here.");
    expect(cfg.recovery_snapshot.position).toBe("Platform Engineer");
    expect(cfg.recovery_snapshot.questions).toEqual([
      { question_text: "How do you debug latency?" },
    ]);
  });

  it("reads realtime and recording policy from environment", () => {
    vi.stubEnv("DEFAULT_VOICE", "marin");
    vi.stubEnv("TURN_DETECTION", "server_vad");
    vi.stubEnv("SILENCE_DURATION_MS", "900");
    vi.stubEnv("INTERRUPT_RESPONSE", "false");
    vi.stubEnv("THINKING_LEVEL", "high");
    vi.stubEnv("RECORDING_REQUIRED", "true");
    vi.stubEnv("RECORDING_S3_BUCKET", "bucket");

    const cfg = resolveSample();
    expect(cfg.voice).toBe("marin");
    expect(cfg.realtime).toEqual({
      turn_detection: "server_vad",
      silence_duration_ms: 900,
      interrupt_response: false,
      thinking_level: "high",
    });
    expect(cfg.recording.required).toBe(true);
    expect(cfg.recording.s3_bucket).toBe("bucket");
  });

  it("rejects malformed metadata, unsupported providers, and invalid durations", () => {
    expect(() => resolveJobConfig("{ not valid json", JOB_ID)).toThrow();
    expect(() =>
      resolveSample((metadata) => {
        metadata.interviewData.model_provider = "anthropic";
      }),
    ).toThrow(/anthropic/i);
    expect(() =>
      resolveSample((metadata) => {
        metadata.interviewData.durationMins = 0;
      }),
    ).toThrow();
  });
});
