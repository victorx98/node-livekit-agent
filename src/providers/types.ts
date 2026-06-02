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

export interface RealtimeProvider {
  id: ModelProvider;
  assertConfig(args: ProviderRuntimeArgs): void;
  createModel(args: CreateRealtimeModelArgs): llm.RealtimeModel;
}
