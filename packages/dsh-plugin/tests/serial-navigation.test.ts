import { SessionId } from "@deepseek-ai/dsh-session/types";
import { describe, expect, it, vi } from "vitest";
import { openSerialChapterSession, registerSerialWorkspace } from "../src/client/serial-navigation.js";

describe("serial native workspace registration", () => {
  it("registers books by path and leaves their folder labels under the host catalogue's control", async () => {
    const workspaces = {
      create: vi.fn(async () => ({ workspaceId: "registered-book" })),
      rename: vi.fn(async () => {}),
    };
    await expect(registerSerialWorkspace(workspaces, "/library/book", "同名书", 12)).resolves.toBe("registered-book");
    expect(workspaces.create).toHaveBeenCalledWith({ path: "/library/book" });
    const existing = { ...workspaces, create: async () => ({ workspaceId: "registered-book", title: "第二批 · 012 · 同名书" }) };
    await expect(registerSerialWorkspace(existing, "/library/book", "同名书", 12)).resolves.toBe("registered-book");
    expect(workspaces.rename).not.toHaveBeenCalled();
  });

  it("still assigns the library workspace title when needed and propagates failures", async () => {
    const workspaces = {
      create: vi.fn(async () => ({ workspaceId: "library" })),
      rename: vi.fn(async () => {}),
    };
    await expect(registerSerialWorkspace(workspaces, "/library", "书库")).resolves.toBe("library");
    expect(workspaces.rename).toHaveBeenCalledWith("library", "书库");
    const unrelated = new Error("workspace rename failed: gateway/unavailable: connection lost");
    workspaces.rename.mockRejectedValueOnce(unrelated);
    await expect(registerSerialWorkspace(workspaces, "/library", "书库")).rejects.toBe(unrelated);
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
