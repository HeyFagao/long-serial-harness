import { SessionId } from "@deepseek-ai/dsh-session/types";
import { describe, expect, it, vi } from "vitest";
import { openSerialChapterSession, registerSerialWorkspace } from "../src/client/serial-navigation.js";

describe("serial native workspace registration", () => {
  const conflict = new Error("workspace rename failed: workspace/name-conflict: Workspace name is already in use");

  it("uses the fixed book number to register a usable sidebar row when another book has the same name", async () => {
    const workspaces = {
      create: vi.fn(async () => ({ workspaceId: "registered-book" })),
      rename: vi.fn(async () => {}).mockRejectedValueOnce(conflict),
    };
    await expect(registerSerialWorkspace(workspaces, "/library/book", "同名书", 12)).resolves.toBe("registered-book");
    expect(workspaces.rename.mock.calls).toEqual([["registered-book", "同名书"], ["registered-book", "同名书 · 012"]]);
    workspaces.rename.mockClear();
    const existing = { ...workspaces, create: async () => ({ workspaceId: "registered-book", title: "同名书 · 012" }) };
    await expect(registerSerialWorkspace(existing, "/library/book", "同名书", 12)).resolves.toBe("registered-book");
    expect(workspaces.rename).not.toHaveBeenCalled();
  });

  it("keeps a registered directory after two naming conflicts and surfaces unrelated failures", async () => {
    const workspaces = {
      create: vi.fn(async () => ({ workspaceId: "registered-book" })),
      rename: vi.fn(async () => {}).mockRejectedValue(conflict),
    };
    await expect(registerSerialWorkspace(workspaces, "/library/book", "同名书", 12)).resolves.toBe("registered-book");
    const unrelated = new Error("workspace rename failed: gateway/unavailable: connection lost");
    workspaces.rename.mockRejectedValueOnce(conflict).mockRejectedValueOnce(unrelated);
    await expect(registerSerialWorkspace(workspaces, "/library/book", "同名书", 12)).rejects.toBe(unrelated);
  });
});

describe("serial chapter native navigation", () => {
  it("refreshes the owner catalog and uses the authoritative child address", async () => {
    const address = { parentSessionId: SessionId("owner"), childSessionId: SessionId("chapter"), mode: "one-shot" as const };
    let ready = false;
    const sessions = {
      refreshProjections: vi.fn(async () => { ready = true; }),
      subagentAddress: vi.fn(() => ready ? address : undefined)
    };
    const navigation = { openSession: vi.fn() };
    await openSerialChapterSession(sessions, navigation, "owner", "chapter");
    expect(sessions.refreshProjections).toHaveBeenCalledWith("owner");
    expect(navigation.openSession).toHaveBeenCalledWith(address);
  });

  it("does not invent an address for an unregistered or differently owned child", async () => {
    const navigation = { openSession: vi.fn() };
    const sessions = { refreshProjections: vi.fn(async () => {}), subagentAddress: vi.fn(() => undefined) };
    await expect(openSerialChapterSession(sessions, navigation, "owner", "missing")).rejects.toThrow("尚未登记");
    await expect(openSerialChapterSession({ ...sessions, subagentAddress: () => ({ parentSessionId: SessionId("other"), childSessionId: SessionId("child"), mode: "one-shot" }) }, navigation, "owner", "child")).rejects.toThrow("尚未登记");
    expect(navigation.openSession).not.toHaveBeenCalled();
  });

  it("opens a persisted task owner even when it has no visible sidebar entry", async () => {
    const sessions = { refreshProjections: vi.fn(async () => {}), subagentAddress: vi.fn(() => undefined) };
    const navigation = { openSession: vi.fn() };
    await openSerialChapterSession(sessions, navigation, "persisted-owner", "persisted-owner");
    expect(navigation.openSession).toHaveBeenCalledWith("persisted-owner");
    expect(sessions.subagentAddress).not.toHaveBeenCalled();
    expect(sessions.refreshProjections).not.toHaveBeenCalled();
  });

  it("reports missing native navigation without attempting another route", async () => {
    const sessions = { refreshProjections: vi.fn(async () => {}), subagentAddress: vi.fn(() => undefined) };
    await expect(openSerialChapterSession(sessions, undefined, "owner", "child")).rejects.toThrow("导航尚未就绪");
    expect(sessions.refreshProjections).not.toHaveBeenCalled();
  });
});
