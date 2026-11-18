import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-subagent";
import z from "@deepseek-ai/schemastery";
import { registerWorkspaceRoute } from "./workspace-route.js";
import { registerSerialRoute } from "./serial-route.js";
import { registerLibraryRoute } from "./serial-library.js";
import { registerLibraryQueueRoute } from "./serial-library-queue-route.js";
import { registerSerialModelsRoute } from "./serial-models.js";
import { assertTrustedWorkspaceAuthority } from "./workspace-request-trust.js";

export { registerWorkspaceRoute } from "./workspace-route.js";

export const name = "oh-story";
export const inject = ["agents", "subagents", "typert", "webServer", "sessionController", "sessions", "workspaceRegistry", "workspaceController"];

interface SettingsPolicyService {
  configure(presentation: { readonly auto?: boolean }, owner?: Context["fiber"]): () => void;
}

/** DSH owns models, providers, presets, permissions, roots, runs, and sessions. */
export interface Config {
  readonly editorMaxBytes?: number;
  readonly trustedHosts?: string[];
  readonly welcomeGuide?: boolean | { readonly get: () => boolean | undefined };
}

export const Config = z.object({
  editorMaxBytes: z.natural().min(65_536).max(8_388_608).default(2_097_152),
  trustedHosts: z.array(String).default([]),
  welcomeGuide: z.boolean().default(true).volatile()
}) as unknown as z<Config>;

export function readWelcomeGuideConfig(value: Config["welcomeGuide"]): boolean {
  const resolved = typeof value === "object" && value !== null ? value.get() : value;
  return resolved ?? true;
}

/** Mount only domain contributions into the current DSH process. */
export function apply(context: Context, config: Config = {}): void {
  const trustedHosts = config.trustedHosts ?? [];
  for (const entry of trustedHosts) assertTrustedWorkspaceAuthority(entry);
  void context.inject(["settings"], (child) => {
    const settings = child.get("settings") as SettingsPolicyService | undefined;
    if (settings !== undefined) child.effect(() => settings.configure({ auto: false }, context.fiber));
  });
  // Writing instructions come from the imported original prompt and the book.
  // Saving and validation belong to the host serial adapter. Do not add upstream
  // Skills, specialist personas, media adapters, or workflow messages to a chapter.
  registerWorkspaceRoute(context, {
    maxBytes: config.editorMaxBytes ?? 2_097_152,
    trustedHosts,
    welcomeGuide: () => readWelcomeGuideConfig(config.welcomeGuide)
  });
  registerSerialRoute(context, { trustedHosts });
  registerLibraryRoute(context, { trustedHosts });
  registerLibraryQueueRoute(context, { trustedHosts });
  registerSerialModelsRoute(context, { trustedHosts });
}

export default { name, inject, Config, apply };
