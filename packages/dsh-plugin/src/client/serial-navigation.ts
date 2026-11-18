import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ISessions, SessionTarget } from "@deepseek-ai/dsh-api-session-controller/client";

/** The official UI owner, also used by DSH's subagent catalog. */
export interface SerialWorkspaceNavigation {
  openSession(target: SessionTarget): void;
}

type SerialSessionCatalog = Pick<ISessions, "refreshProjections" | "subagentAddress">;

export interface SerialWorkspaceRegistration {
  create(input: { path: string }): Promise<{ workspaceId: string; title?: string }>;
  rename(workspaceId: string, title: string): Promise<unknown>;
}

function workspaceNameConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("workspace rename failed: workspace/name-conflict:");
}

export async function registerSerialWorkspace(workspaces: SerialWorkspaceRegistration, path: string, title: string, sequence?: number): Promise<string> {
  const { workspaceId, title: existingTitle } = await workspaces.create({ path });
  const numberedTitle = sequence === undefined ? undefined : `${title} · ${String(sequence).padStart(3, "0")}`;
  if (existingTitle === title || (numberedTitle !== undefined && existingTitle === numberedTitle)) return workspaceId;
  try {
    await workspaces.rename(workspaceId, title);
  } catch (error) {
    if (numberedTitle === undefined || !workspaceNameConflict(error)) throw error;
    try {
      await workspaces.rename(workspaceId, numberedTitle);
    } catch (secondError) {
      // The registered directory already has a distinct workspace identity.
      if (!workspaceNameConflict(secondError)) throw secondError;
    }
  }
  return workspaceId;
}

/** Resolve the durable native child address; never guess a URL or a child interaction mode. */
export async function openSerialChapterSession(
  sessions: SerialSessionCatalog,
  navigation: SerialWorkspaceNavigation | undefined,
  ownerSessionId: string,
  childSessionId: string
): Promise<void> {
  const ownerId = ownerSessionId as SessionId;
  const childId = childSessionId as SessionId;
  if (navigation === undefined) throw new Error("Harness 会话导航尚未就绪，请稍后重试。");
  if (childSessionId === ownerSessionId) { navigation.openSession(ownerId); return; }
  await sessions.refreshProjections(ownerId);
  const address = sessions.subagentAddress(childId);
  if (address === undefined || address.parentSessionId !== ownerSessionId) {
    throw new Error("当前章的写作会话尚未登记到 Harness，请稍后重试。");
  }
  navigation.openSession(address);
}
