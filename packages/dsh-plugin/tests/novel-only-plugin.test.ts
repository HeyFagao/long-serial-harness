import type { Context } from "@deepseek-ai/cordis";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/workspace-route.js", () => ({ registerWorkspaceRoute: vi.fn() }));
vi.mock("../src/serial-route.js", () => ({ registerSerialRoute: vi.fn() }));
vi.mock("../src/serial-library.js", () => ({ registerLibraryRoute: vi.fn() }));
vi.mock("../src/serial-library-queue-route.js", () => ({ registerLibraryQueueRoute: vi.fn() }));
vi.mock("../src/serial-models.js", () => ({ registerSerialModelsRoute: vi.fn() }));

import { apply, inject } from "../src/index.js";
import { registerWorkspaceRoute } from "../src/workspace-route.js";
import { registerSerialRoute } from "../src/serial-route.js";
import { registerLibraryRoute } from "../src/serial-library.js";
import { registerLibraryQueueRoute } from "../src/serial-library-queue-route.js";
import { registerSerialModelsRoute } from "../src/serial-models.js";

describe("long-serial plugin scope", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("mounts book routes without installing any upstream Skills, personas, or workflow hooks", () => {
    const context = {
      inject: vi.fn(),
      on: vi.fn(),
      skills: { registerProvider: vi.fn() },
      tools: { register: vi.fn() }
    };
    apply(context as unknown as Context);
    expect(registerWorkspaceRoute).toHaveBeenCalledOnce();
    expect(registerSerialRoute).toHaveBeenCalledOnce();
    expect(registerLibraryRoute).toHaveBeenCalledOnce();
    expect(registerLibraryQueueRoute).toHaveBeenCalledOnce();
    expect(registerSerialModelsRoute).toHaveBeenCalledOnce();
    expect(context.skills.registerProvider).not.toHaveBeenCalled();
    expect(context.tools.register).not.toHaveBeenCalled();
    expect(context.on).not.toHaveBeenCalled();
    expect(inject).not.toContain("skills");
    expect(inject).toEqual(expect.arrayContaining(["agents", "workspaceRegistry"]));
  });
});
