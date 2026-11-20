import type { SharedTaskSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskBoardFamilyThreadIds, taskBoardHasWork } from "./taskBoardAutoOpen";

const thread = (id: string, rootThreadId: string, environmentId = "env-1") => ({
  id,
  environmentId,
  lineage: { rootThreadId },
});

const task = (input: {
  id: string;
  status: SharedTaskSummary["status"];
  threads?: ReadonlyArray<{ threadId: string; environmentId?: string }>;
  projectId?: string | null;
}): SharedTaskSummary =>
  ({
    id: input.id,
    version: 1,
    title: input.id,
    status: input.status,
    kind: "feature",
    tags: [],
    focused: false,
    projectId: input.projectId ?? null,
    workspaceRoot: null,
    threads: input.threads ?? [],
    updatedAt: "2026-11-20T00:00:00.000Z",
    goalExcerpt: "",
    nextStepExcerpt: "",
    blockedReason: null,
    stepCount: 0,
    completedSteps: 0,
    assignees: [],
  }) satisfies SharedTaskSummary;

const base = { environmentId: "env-1", isFreshThread: false, projectId: null } as const;

describe("taskBoardFamilyThreadIds", () => {
  it("includes an omitted or archived parent from the lineage", () => {
    const family = taskBoardFamilyThreadIds({
      threadId: "grandchild",
      threadTreeRootId: "root",
      parentThreadId: "parent",
      environmentId: "env-1",
      threads: [thread("grandchild", "root")],
    });
    expect(family.has("parent")).toBe(true);
  });
  it("collects the root and every thread forked from it", () => {
    const family = taskBoardFamilyThreadIds({
      threadId: "b",
      threadTreeRootId: "a",
      environmentId: "env-1",
      threads: [
        thread("a", "a"),
        thread("b", "a"),
        thread("c", "a"),
        thread("d", "a"),
        thread("unrelated", "unrelated"),
      ],
    });
    expect([...family].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores threads from another environment", () => {
    const family = taskBoardFamilyThreadIds({
      threadId: "b",
      threadTreeRootId: "a",
      environmentId: "env-1",
      threads: [thread("a", "a"), thread("b", "a"), thread("elsewhere", "a", "env-2")],
    });
    expect(family.has("elsewhere")).toBe(false);
  });

  it("keeps a thread with no lineage root on its own", () => {
    const family = taskBoardFamilyThreadIds({
      threadId: "b",
      threadTreeRootId: null,
      environmentId: "env-1",
      threads: [thread("a", "a"), thread("b", "a")],
    });
    expect([...family]).toEqual(["b"]);
  });
});

describe("taskBoardHasWork", () => {
  it("opens for a task another conversation in the tree is working on", () => {
    expect(
      taskBoardHasWork({
        ...base,
        familyThreadIds: new Set(["a", "b"]),
        tasks: [task({ id: "t", status: "doing", threads: [{ threadId: "a" }] })],
      }),
    ).toBe(true);
  });

  it("opens for a sibling conversation's task", () => {
    expect(
      taskBoardHasWork({
        ...base,
        familyThreadIds: new Set(["a", "b", "c"]),
        tasks: [task({ id: "t", status: "waiting", threads: [{ threadId: "c" }] })],
      }),
    ).toBe(true);
  });

  it("ignores finished tasks and other environments", () => {
    expect(
      taskBoardHasWork({
        ...base,
        familyThreadIds: new Set(["a"]),
        tasks: [
          task({ id: "done", status: "done", threads: [{ threadId: "a" }] }),
          task({
            id: "remote",
            status: "doing",
            threads: [{ threadId: "a", environmentId: "env-2" }],
          }),
        ],
      }),
    ).toBe(false);
  });

  it("falls back to an in-progress project task only on an unstarted thread", () => {
    const tasks = [task({ id: "t", status: "doing", projectId: "project-a" })];
    expect(
      taskBoardHasWork({
        ...base,
        isFreshThread: true,
        projectId: "project-a",
        familyThreadIds: new Set(["a"]),
        tasks,
      }),
    ).toBe(true);
    expect(taskBoardHasWork({ ...base, familyThreadIds: new Set(["a"]), tasks })).toBe(false);
  });
});
