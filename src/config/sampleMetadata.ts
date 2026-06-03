import type { AgentMetadata } from "../types/job.js";

// The §6 example dispatch metadata, as a reusable test/fixture factory.
// Returns a deep-fresh object each call so tests can mutate it safely.
export function sampleAgentMetadata(): AgentMetadata {
  return {
    interviewId: "int_789",
    interviewData: {
      objectId: "int_789",
      student: {
        objectId: "stu_456",
        name: "Jordan Lee",
        email: "jordan@example.com",
        background: "CS senior, 2 internships",
        experience_level: "entry",
      },
      participant: { name: "Jordan Lee", email: "jordan@example.com" },
      interview_type: "technical",
      language: "en-US",
      position: "Node.js Backend Engineer",
      durationMins: 60,
      model_provider: "openai",
      model_name: "gpt-realtime-2",
      interview_questions: [
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
      company: "MentorX",
      status: "scheduled",
      created_at: "2026-06-01T17:50:00.000Z",
      updated_at: "2026-06-01T17:55:00.000Z",
      systemInstruction: "You are a professional technical interviewer...",
    },
    studentId: "stu_456",
    participantId: "part_001",
    participantInfo: { name: "Jordan Lee", email: "jordan@example.com" },
    systemInstruction: "You are a professional technical interviewer...",
    recordingKey: "livekit-interviews/int_789/job_123.mp4",
    options: {
      autoStart: true,
      enableLogging: true,
      enableRecording: true,
    },
    createdAt: "2026-06-01T17:55:00.000Z",
  };
}
