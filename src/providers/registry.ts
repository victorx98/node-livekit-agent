import type { llm } from "@livekit/agents";
import { googleProvider } from "./google.js";
import { openaiProvider } from "./openai.js";
import type {
  CreateRealtimeModelArgs,
  ProviderRuntimeArgs,
  RealtimeProvider,
  RealtimeProviderCapabilities,
} from "./types.js";
import type { ModelProvider } from "../types/config.js";

export type RealtimeProviderRegistry = Map<ModelProvider, RealtimeProvider>;

export const defaultRealtimeProviderRegistry: RealtimeProviderRegistry = new Map([
  [openaiProvider.id, openaiProvider],
  [googleProvider.id, googleProvider],
]);

export function getRealtimeProvider(
  provider: ModelProvider,
  registry: RealtimeProviderRegistry = defaultRealtimeProviderRegistry,
): RealtimeProvider {
  const resolved = registry.get(provider);
  if (!resolved) {
    throw new Error(`No realtime provider registered for ${provider}.`);
  }
  return resolved;
}

export function assertProviderAllowed(
  args: ProviderRuntimeArgs,
  registry: RealtimeProviderRegistry = defaultRealtimeProviderRegistry,
): void {
  getRealtimeProvider(args.cfg.model_provider, registry).assertConfig(args);
}

export function getRealtimeProviderCapabilities(
  args: ProviderRuntimeArgs,
  registry: RealtimeProviderRegistry = defaultRealtimeProviderRegistry,
): RealtimeProviderCapabilities {
  return getRealtimeProvider(args.cfg.model_provider, registry).capabilities(args);
}

export function createRealtimeModel(
  args: CreateRealtimeModelArgs,
  registry: RealtimeProviderRegistry = defaultRealtimeProviderRegistry,
): llm.RealtimeModel {
  const provider = getRealtimeProvider(args.cfg.model_provider, registry);
  provider.assertConfig(args);
  return provider.createModel(args);
}
