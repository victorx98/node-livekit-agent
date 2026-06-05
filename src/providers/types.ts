import type { llm } from "@livekit/agents";
import type { Env } from "../config/env.js";
import type { ResolvedJobConfig, ModelProvider } from "../types/config.js";

export interface ProviderRuntimeArgs {
  cfg: ResolvedJobConfig;
  env: Env;
}

export interface CreateRealtimeModelArgs extends ProviderRuntimeArgs {
  instructions: string;
}

export type NativeRecoveryMode = "chat_context_replay" | "session_resumption";

export interface RealtimeProviderCapabilities {
  nativeRecovery: NativeRecoveryMode;
  supportsProgrammaticGreeting: boolean;
}

export interface RealtimeProvider {
  id: ModelProvider;
  capabilities(args: ProviderRuntimeArgs): RealtimeProviderCapabilities;
  assertConfig(args: ProviderRuntimeArgs): void;
  createModel(args: CreateRealtimeModelArgs): llm.RealtimeModel;
}
