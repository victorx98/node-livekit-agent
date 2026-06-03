import { describe, it, expect, vi } from "vitest";
import { resolveJobConfig } from "./resolveConfig.js";
import { sampleAgentMetadata } from "./sampleMetadata.js";
import type { AgentMetadata } from "../types/job.js";

const JOB_ID = "job_from_context_123";

/** Stringify metadata the way it arrives on the wire (LiveKit job.metadata). */
function wire(meta: unknown): string {
  return JSON.stringify(meta);
}

function resolveSample(mutate?: (m: AgentMetadata) => void) {
  const m = sampleAgentMetadata();
  mutate?.(m);
  return resolveJobConfig(wire(m), JOB_ID);
}

describe("resolveJobConfig — §8.3 wire → internal mapping", () => {
  describe("happy path: full §6 example maps every field per the table", () => {
    it("maps identity fields", () => {
      const cfg = resolveSample();
      // job_id is NOT on the wire — it comes from JobContext (room/job id).
      expect(cfg.job_id).toBe(JOB_ID);
      expect(cfg.interview_id).toBe("int_789");
      expect(cfg.student_id).toBe("stu_456");
      expect(cfg.participant_id).toBe("part_001");
    });

    it("maps provider selection and language", () => {
      const cfg = resolveSample();
      expect(cfg.model_provider).toBe("openai");
      expect(cfg.model).toBe("gpt-realtime-2");
      expect(cfg.language).toBe("en-US");
    });

    it("maps interview content", () => {
      const cfg = resolveSample();
      expect(cfg.interview.role).toBe("Node.js Backend Engineer");
      expect(cfg.interview.type).toBe("technical");
      expect(cfg.interview.company).toBe("MentorX");
      expect(cfg.interview.duration_minutes).toBe(60);
      expect(cfg.interview.system_prompt).toBe("You are a professional technical interviewer...");
      expect(cfg.interview.student.name).toBe("Jordan Lee");
      expect(cfg.interview.participant.name).toBe("Jordan Lee");
    });

    it("derives interview.title as 'position @ company (type)'", () => {
      const cfg = resolveSample();
      expect(cfg.interview.title).toBe("Node.js Backend Engineer @ MentorX (technical)");
    });

    it("passes structured InterviewQuestion[] through intact", () => {
      const cfg = resolveSample();
      expect(cfg.interview.questions).toHaveLength(2);
      expect(cfg.interview.questions[0]).toEqual({
        question_text: "Tell me about your backend experience.",
        purpose_and_focus: "Warm-up; gauge depth.",
        sub_points: ["scale", "ownership"],
        category: "background",
      });
      expect(cfg.interview.questions[1]).toEqual({
        question_text: "How would you debug a production latency issue?",
        category: "problem-solving",
      });
    });

    it("maps recording wire fields", () => {
      const cfg = resolveSample();
      expect(cfg.recording.enabled).toBe(true); // options.enableRecording
      expect(cfg.recording.key).toBe("livekit-interviews/int_789/job_123.mp4");
    });

    it("maps behavior option flags", () => {
      const cfg = resolveSample();
      expect(cfg.options.autoStart).toBe(true);
      expect(cfg.options.enableLogging).toBe(true);
    });
  });

  describe("provider normalization", () => {
    it.each([
      ["openai", "openai"],
      ["OpenAI", "openai"],
      ["OPENAI", "openai"],
      ["google", "google"],
      ["Google", "google"],
      ["gemini", "google"],
      ["GEMINI", "google"],
    ])("normalizes %s → %s", (input, expected) => {
      const cfg = resolveSample((m) => {
        m.interviewData.model_provider = input;
      });
      expect(cfg.model_provider).toBe(expected);
    });

    it("throws on an unknown provider", () => {
      expect(() =>
        resolveSample((m) => {
          m.interviewData.model_provider = "anthropic";
        }),
      ).toThrow(/anthropic/i);
    });
  });

  describe("system_prompt fallback (prefer top-level)", () => {
    it("uses the top-level systemInstruction when present", () => {
      const cfg = resolveSample((m) => {
        m.systemInstruction = "TOP-LEVEL PROMPT";
        m.interviewData.systemInstruction = "INNER PROMPT";
      });
      expect(cfg.interview.system_prompt).toBe("TOP-LEVEL PROMPT");
    });

    it("falls back to interviewData.systemInstruction when top-level is empty", () => {
      const cfg = resolveSample((m) => {
        m.systemInstruction = "";
        m.interviewData.systemInstruction = "INNER PROMPT";
      });
      expect(cfg.interview.system_prompt).toBe("INNER PROMPT");
    });
  });

  describe("env-sourced fields (not on the wire)", () => {
    it("reads voice and realtime tuning from env", () => {
      vi.stubEnv("DEFAULT_VOICE", "marin");
      vi.stubEnv("TURN_DETECTION", "server_vad");
      vi.stubEnv("SILENCE_DURATION_MS", "900");
      vi.stubEnv("INTERRUPT_RESPONSE", "false");
      vi.stubEnv("THINKING_LEVEL", "high");

      const cfg = resolveSample();
      expect(cfg.voice).toBe("marin");
      expect(cfg.realtime.turn_detection).toBe("server_vad");
      expect(cfg.realtime.silence_duration_ms).toBe(900);
      expect(cfg.realtime.interrupt_response).toBe(false);
      expect(cfg.realtime.thinking_level).toBe("high");
    });

    it("applies realtime defaults when env is unset", () => {
      vi.stubEnv("DEFAULT_VOICE", "");
      vi.stubEnv("TURN_DETECTION", "");
      vi.stubEnv("SILENCE_DURATION_MS", "");
      vi.stubEnv("INTERRUPT_RESPONSE", "");
      vi.stubEnv("THINKING_LEVEL", "");

      const cfg = resolveSample();
      expect(cfg.realtime.turn_detection).toBe("semantic_vad");
      expect(cfg.realtime.silence_duration_ms).toBe(700);
      expect(cfg.realtime.interrupt_response).toBe(true);
      expect(cfg.realtime.thinking_level).toBe("minimal");
    });

    it("reads recording env policy fields", () => {
      vi.stubEnv("RECORDING_REQUIRED", "true");
      vi.stubEnv("RECORDING_S3_BUCKET", "my-bucket");
      vi.stubEnv("AWS_REGION", "us-east-1");
      vi.stubEnv("RECORDING_AUDIO_ONLY", "true");

      const cfg = resolveSample();
      expect(cfg.recording.required).toBe(true);
      expect(cfg.recording.s3_bucket).toBe("my-bucket");
      expect(cfg.recording.s3_region).toBe("us-east-1");
      expect(cfg.recording.audio_only).toBe(true);
    });

    it("defaults recording.required to false when RECORDING_REQUIRED is not 'true'", () => {
      vi.stubEnv("RECORDING_REQUIRED", "");
      const cfg = resolveSample();
      expect(cfg.recording.required).toBe(false);
    });

    it("uses S3_BUCKET when RECORDING_S3_BUCKET is unset", () => {
      vi.stubEnv("RECORDING_S3_BUCKET", "");
      vi.stubEnv("S3_BUCKET", "python-era-bucket");

      const cfg = resolveSample();
      expect(cfg.recording.s3_bucket).toBe("python-era-bucket");
    });
  });

  describe("compatibility normalization and optional/missing wire fields", () => {
    it("defaults missing systemInstruction and recordingKey to empty strings", () => {
      const cfg = resolveSample((m) => {
        delete (m as Partial<AgentMetadata>).systemInstruction;
        delete (m as Partial<AgentMetadata>).recordingKey;
        m.interviewData.systemInstruction = "";
      });
      expect(cfg.interview.system_prompt).toBe("");
      expect(cfg.recording.key).toBe("");
    });

    it("defaults missing interview_questions to []", () => {
      const cfg = resolveSample((m) => {
        delete (m.interviewData as Partial<AgentMetadata["interviewData"]>).interview_questions;
      });
      expect(cfg.interview.questions).toEqual([]);
    });

    it("defaults interview_type/company/language when missing", () => {
      const cfg = resolveSample((m) => {
        const d = m.interviewData as Partial<AgentMetadata["interviewData"]>;
        delete d.interview_type;
        delete d.company;
        delete d.language;
      });
      expect(cfg.interview.type).toBe("general");
      expect(cfg.interview.company).toBe("");
      expect(cfg.language).toBe("en-US");
    });

    it("defaults options flags (autoStart/enableLogging true, enableRecording false)", () => {
      const cfg = resolveSample((m) => {
        m.options = {} as AgentMetadata["options"];
      });
      expect(cfg.options.autoStart).toBe(true);
      expect(cfg.options.enableLogging).toBe(true);
      expect(cfg.recording.enabled).toBe(false);
    });

    it("derives options.enableRecording from top-level enableRecording", () => {
      const cfg = resolveSample((m) => {
        delete (m as Partial<AgentMetadata>).options;
        (m as unknown as Record<string, unknown>).enableRecording = true;
      });

      expect(cfg.recording.enabled).toBe(true);
    });

    it("derives title without company as 'position (type)'", () => {
      const cfg = resolveSample((m) => {
        m.interviewData.company = "";
      });
      expect(cfg.interview.title).toBe("Node.js Backend Engineer (technical)");
    });

    it("accepts snake_case top-level metadata and modelProvider aliases", () => {
      const canonical = sampleAgentMetadata();
      const meta: Record<string, unknown> = {
        interview_id: canonical.interviewId,
        interview_data: {
          ...canonical.interviewData,
          model_provider: undefined,
          modelProvider: "Gemini",
        },
        student_id: null,
        participant_id: "snake-participant",
        participant_info: canonical.participantInfo,
        system_instruction: "snake prompt",
        recording_key: "snake/path.mp4",
        options: { autoStart: false, enableLogging: false, enableRecording: true },
      };

      const cfg = resolveJobConfig(meta, JOB_ID);

      expect(cfg.interview_id).toBe(canonical.interviewId);
      expect(cfg.student_id).toBeNull();
      expect(cfg.participant_id).toBe("snake-participant");
      expect(cfg.model_provider).toBe("google");
      expect(cfg.interview.system_prompt).toBe("snake prompt");
      expect(cfg.recording.key).toBe("snake/path.mp4");
      expect(cfg.options.autoStart).toBe(false);
      expect(cfg.options.enableLogging).toBe(false);
    });

    it("accepts Python README-style minimal metadata", () => {
      const cfg = resolveJobConfig(
        {
          interviewId: "456",
          interviewData: {
            job_title: "Senior Software Engineer",
            questions: ["Tell me about yourself", "What are your strengths?"],
            model_provider: "google",
          },
          enableRecording: true,
          options: { autoStart: true },
        },
        "job_python_minimal",
      );

      expect(cfg.interview_id).toBe("456");
      expect(cfg.student_id).toBeNull();
      expect(cfg.participant_id).toBe("participant");
      expect(cfg.model_provider).toBe("google");
      expect(cfg.model).toBe("gemini-live-2.5-flash-native-audio");
      expect(cfg.interview.role).toBe("Senior Software Engineer");
      expect(cfg.interview.duration_minutes).toBe(30);
      expect(cfg.interview.participant).toEqual({ name: "Participant", email: null });
      expect(cfg.interview.questions).toEqual([
        { question_text: "Tell me about yourself" },
        { question_text: "What are your strengths?" },
      ]);
      expect(cfg.recording.enabled).toBe(true);
    });

    it("accepts JSON-stringified interview_data and falls back to OPENAI_MODEL", () => {
      vi.stubEnv("OPENAI_MODEL", "gpt-realtime-2");

      const cfg = resolveJobConfig(
        {
          interview_id: "json-inner",
          interview_data: JSON.stringify({
            job_title: "Platform Engineer",
            questions: ["How do you debug latency?"],
            modelProvider: "openai",
          }),
        },
        "job_json_inner",
      );

      expect(cfg.model_provider).toBe("openai");
      expect(cfg.model).toBe("gpt-realtime-2");
      expect(cfg.interview.role).toBe("Platform Engineer");
      expect(cfg.interview.questions).toEqual([{ question_text: "How do you debug latency?" }]);
    });

    it("falls back to requested default models when metadata omits model_name", () => {
      const openaiCfg = resolveSample((m) => {
        m.interviewData.model_provider = "openai";
        delete (m.interviewData as Partial<AgentMetadata["interviewData"]>).model_name;
      });
      const geminiCfg = resolveSample((m) => {
        m.interviewData.model_provider = "google";
        delete (m.interviewData as Partial<AgentMetadata["interviewData"]>).model_name;
      });

      expect(openaiCfg.model).toBe("gpt-realtime-2");
      expect(geminiCfg.model).toBe("gemini-live-2.5-flash-native-audio");
    });

    it("uses OPENAI_MODEL and GEMINI_MODEL env fallbacks when present", () => {
      vi.stubEnv("OPENAI_MODEL", "gpt-realtime-env");
      vi.stubEnv("GEMINI_MODEL", "gemini-env");

      const openaiCfg = resolveSample((m) => {
        m.interviewData.model_provider = "openai";
        delete (m.interviewData as Partial<AgentMetadata["interviewData"]>).model_name;
      });
      const geminiCfg = resolveSample((m) => {
        m.interviewData.model_provider = "google";
        delete (m.interviewData as Partial<AgentMetadata["interviewData"]>).model_name;
      });

      expect(openaiCfg.model).toBe("gpt-realtime-env");
      expect(geminiCfg.model).toBe("gemini-env");
    });
  });

  describe("invalid input / error paths", () => {
    it("throws on malformed JSON", () => {
      expect(() => resolveJobConfig("{ not valid json", JOB_ID)).toThrow();
    });

    it("throws when durationMins is zero or negative", () => {
      expect(() =>
        resolveSample((m) => {
          m.interviewData.durationMins = 0;
        }),
      ).toThrow();
      expect(() =>
        resolveSample((m) => {
          m.interviewData.durationMins = -5;
        }),
      ).toThrow();
    });

    it("throws when required position is missing", () => {
      expect(() =>
        resolveSample((m) => {
          delete (m.interviewData as Partial<AgentMetadata["interviewData"]>).position;
        }),
      ).toThrow();
    });

    it("throws when required interviewId is missing", () => {
      expect(() =>
        resolveSample((m) => {
          delete (m as Partial<AgentMetadata>).interviewId;
        }),
      ).toThrow();
    });
  });

  describe("student_id may be null", () => {
    it("preserves a null studentId", () => {
      const cfg = resolveSample((m) => {
        m.studentId = null;
      });
      expect(cfg.student_id).toBeNull();
    });
  });
});
