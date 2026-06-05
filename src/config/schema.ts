import { z } from "zod";

// Defensive validation of the wire contract (§8.4). The upstream `AgentMetadata`
// shape (src/types/job.ts) is the source of truth, but it can drift, so we
// validate the subset the resolver actually consumes and apply safe defaults.
// Unknown keys are stripped by zod's default object parsing.
export const AgentMetadataSchema = z.object({
  interviewId: z.string(),
  studentId: z.string().nullable(),
  participantId: z.string(),
  systemInstruction: z.string().optional().default(""),
  greetingPrompt: z.string().optional().default(""),
  recordingKey: z.string().optional().default(""),
  options: z.object({
    autoStart: z.boolean().default(true),
    enableLogging: z.boolean().default(true),
    enableRecording: z.boolean().default(false),
  }),
  interviewData: z.object({
    position: z.string(),
    interview_type: z.string().default("general"),
    company: z.string().default(""),
    language: z.string().default("en-US"),
    durationMins: z.number().positive(),
    model_provider: z.string(),
    model_name: z.string(),
    interview_questions: z
      .array(
        z
          .object({
            question_text: z.string(),
            purpose_and_focus: z.string().optional(),
            sub_points: z.array(z.string()).optional(),
            category: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    systemInstruction: z.string().optional().default(""),
    student: z.object({
      objectId: z.string().nullable().optional(),
      name: z.string(),
      email: z.string().nullable(),
      background: z.string().optional(),
      experience_level: z.string().optional(),
    }),
    participant: z.object({ name: z.string(), email: z.string().nullable() }),
  }),
  participantInfo: z.object({ name: z.string(), email: z.string().nullable() }),
});

export type ValidatedAgentMetadata = z.infer<typeof AgentMetadataSchema>;
