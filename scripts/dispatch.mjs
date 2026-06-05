// Manual verification helper for the Phase 1 walking skeleton.
//
// Creates an explicit agent dispatch (carrying AgentMetadata) into a room and
// prints a candidate access token so you can join and have a real spoken
// interview. The running worker (node dist/main.js dev) picks up the dispatch.
//
// Usage:
//   node --env-file=.env scripts/dispatch.mjs [roomName]
//
// Requires in the environment: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
// The worker process also needs credentials for the selected model provider.

import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";

const url = process.env.LIVEKIT_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const agentName = process.env.AGENT_NAME ?? "interview-agent";
const modelProvider = process.env.DISPATCH_MODEL_PROVIDER ?? "openai";
const modelName =
  process.env.DISPATCH_MODEL_NAME ??
  (modelProvider.toLowerCase() === "openai"
    ? (process.env.OPENAI_MODEL ?? "gpt-realtime-2")
    : (process.env.GEMINI_MODEL ?? "gemini-live-2.5-flash-native-audio"));

if (!url || !apiKey || !apiSecret) {
  console.error("Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in env.");
  process.exit(1);
}

const room = process.argv[2] ?? `interview-test-${Date.now()}`;

const interviewQuestions = [
  {
    question_text: "Tell me about a backend system you've built and your role in it.",
    purpose_and_focus: "Warm-up; gauge depth and ownership.",
    sub_points: ["scale", "your specific contribution"],
    category: "background",
  },
  {
    question_text: "How would you debug a sudden spike in production API latency?",
    purpose_and_focus: "Problem-solving and systematic thinking.",
    category: "problem-solving",
  },
  {
    question_text: "How do you decide between SQL and NoSQL for a new service?",
    category: "system-design",
  },
];

const systemInstruction = `
You are a friendly, professional technical interviewer.
Complete the interview in English and keep questions concise and spoken.
Ask the following questions in order, using their private context for brief follow-ups:
${JSON.stringify(interviewQuestions)}
Thank the candidate and end politely after the final question.
`.trim();

// A realistic API-shaped AgentMetadata payload (§8.1). The systemInstruction
// contains the complete interview plan; structured interviewData is retained
// only for operations and durable recovery.
const metadata = {
  interviewId: "int_demo",
  studentId: "stu_demo",
  participantId: "part_demo",
  systemInstruction,
  recordingKey: "",
  options: { autoStart: true, enableLogging: true, enableRecording: false },
  participantInfo: { name: "Candidate", email: null },
  createdAt: new Date().toISOString(),
  interviewData: {
    objectId: "int_demo",
    student: {
      objectId: "stu_demo",
      name: "Candidate",
      email: null,
      background: "Software engineer with 3 years of backend experience",
      experience_level: "mid",
    },
    participant: { name: "Candidate", email: null },
    interview_type: "technical",
    language: "en-US",
    position: "Node.js Backend Engineer",
    durationMins: 10,
    model_provider: modelProvider,
    model_name: modelName,
    company: "MentorX",
    status: "scheduled",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    systemInstruction,
    interview_questions: interviewQuestions,
  },
};

async function main() {
  const dispatchClient = new AgentDispatchClient(url, apiKey, apiSecret);
  const dispatch = await dispatchClient.createDispatch(room, agentName, {
    metadata: JSON.stringify(metadata),
  });

  const at = new AccessToken(apiKey, apiSecret, { identity: "candidate", name: "Candidate" });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  const token = await at.toJwt();

  console.log("\n✅ Dispatch created");
  console.log(`   room:       ${room}`);
  console.log(`   agentName:  ${agentName}`);
  console.log(`   dispatchId: ${dispatch.id}`);
  console.log(`\n🔗 Join as the candidate and talk to the interviewer:`);
  console.log(`   1. Open https://agents-playground.livekit.io/`);
  console.log(`   2. Choose "Manually" / custom connection`);
  console.log(`   3. Server URL: ${url}`);
  console.log(`   4. Token:\n\n${token}\n`);
  console.log("Make sure the worker is running:  node --env-file=.env dist/main.js dev");
}

main().catch((err) => {
  console.error("Dispatch failed:", err);
  process.exit(1);
});
