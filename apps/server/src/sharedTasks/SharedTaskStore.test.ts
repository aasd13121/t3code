import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { SharedTaskStore } from "./SharedTaskStore.ts";

const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-02T00:00:00.000Z";
const source = { actor: "ai", threadId: "first", environmentId: "local" } as const;

describe("SharedTaskStore", () => {
  it("links sent conversations without overwriting concurrent progress or step assignments", () => {
    const store = new SharedTaskStore(":memory:");
    try {
      store.create(
        { title: "Launch", steps: [{ id: "work", title: "Work", status: "todo" }] },
        source,
        { id: "launch", now },
      );
      store.update(
        {
          taskId: "launch",
          expectedVersion: 1,
          patch: { nextStep: "Peer edit" },
          note: "Peer progress",
        },
        source,
        later,
      );
      const input = {
        taskId: "launch",
        stepId: "work",
        thread: { threadId: "sent", environmentId: "local" },
      };
      const linked = store.linkThread(input, later);
      expect(linked).toMatchObject({
        version: 3,
        status: "doing",
        nextStep: "Peer edit",
        steps: [{ id: "work", status: "doing", thread: input.thread }],
      });
      expect(store.linkThread(input, later).version).toBe(3);
      expect(() =>
        store.linkThread({ ...input, thread: { ...input.thread, threadId: "peer" } }, later),
      ).toThrow("Another session updated");
      expect(store.get({ taskId: "launch" }).task.version).toBe(3);
      const followup = store.linkThread(
        { taskId: "launch", thread: { threadId: "followup", environmentId: "remote" } },
        later,
      );
      expect(followup.threads.at(-1)).toEqual({ threadId: "followup", environmentId: "remote" });
      const assigned = store.create(
        {
          title: "Preassigned",
          steps: [{ id: "work", title: "Work", status: "todo", thread: input.thread }],
        },
        { ...source, ...input.thread },
        { id: "assigned", now },
      );
      const assignedInput = { ...input, taskId: assigned.id };
      const restarted = store.linkThread(assignedInput, later);
      expect(restarted.steps[0]?.status).toBe("doing");
      expect(restarted.version).toBe(assigned.version + 1);
      const completed = store.progress(
        {
          taskId: assigned.id,
          expectedVersion: restarted.version,
          completedStepIds: ["work"],
          note: "Complete before the reply arrives",
        },
        source,
        later,
      );
      expect(store.linkThread(assignedInput, later).version).toBe(completed.version);
      expect(store.get({ taskId: assigned.id }).task.steps[0]?.status).toBe("done");
      store.update(
        {
          taskId: "launch",
          expectedVersion: followup.version,
          patch: { status: "archived" },
          note: "Archived",
        },
        source,
        later,
      );
      expect(() => store.linkThread({ ...input, thread: { threadId: "late" } }, later)).toThrow(
        "Check the task steps",
      );
    } finally {
      store.close();
    }
  });

  it("filters before pagination and finds assigned threads beyond the first page", () => {
    const store = new SharedTaskStore(":memory:");
    try {
      store.create(
        {
          title: "Older task",
          tags: ["target"],
          focused: true,
          steps: [
            {
              id: "work",
              title: "Work",
              status: "todo",
              thread: { threadId: "worker", environmentId: "local" },
            },
          ],
        },
        source,
        { id: "older", now },
      );
      for (let index = 0; index < 205; index++) {
        const task = store.create({ title: `Noise ${index}` }, source, {
          id: `noise-${index}`,
          now: later,
        });
        store.update(
          { taskId: task.id, expectedVersion: 1, patch: { status: "archived" }, note: "Archive" },
          source,
          later,
        );
      }
      expect(
        store.list({ includeArchived: true, statuses: ["todo"], tag: "target", focused: true }),
      ).toMatchObject({
        total: 1,
        tasks: [{ id: "older" }],
      });
      expect(
        store.list({
          includeArchived: true,
          threads: [{ threadId: "worker", environmentId: "local" }],
          limit: 1,
        }),
      ).toMatchObject({ total: 1, tasks: [{ id: "older" }] });
      expect(store.list({ threads: [{ threadId: "worker", environmentId: "remote" }] }).total).toBe(
        0,
      );
      const first = store.list({ includeArchived: true, limit: 200 });
      const second = store.list({ includeArchived: true, limit: 200, offset: 200 });
      expect(first.tasks).toHaveLength(200);
      expect(second.tasks).toHaveLength(6);
      expect(new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size).toBe(206);
      expect(store.list({ taskId: "older", includeArchived: true }).tasks).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it.effect(
    "persists cross-session progress and rejects a stale writer without losing history",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-shared-task-" });
        const dbPath = path.join(directory, "tasks.sqlite");
        const first = new SharedTaskStore(dbPath);
        const second = new SharedTaskStore(dbPath);
        try {
          const created = first.create(
            {
              title: "Ship a fix",
              goal: "Make the save action work",
              nextStep: "Reproduce it",
              projectId: "project",
              tags: ["bug", "bug"],
              focused: true,
              steps: [
                {
                  id: "reproduce",
                  title: "Reproduce",
                  status: "todo",
                  assignee: "Diagnostics",
                  thread: { threadId: "first", environmentId: "local" },
                },
              ],
            },
            source,
            { id: "task", now },
          );
          const stale = second.get({ taskId: created.id }).task;
          const changed = first.progress(
            {
              taskId: created.id,
              expectedVersion: created.version,
              note: "Reproduced the save failure",
              nextStep: "Implement the fix",
              completedStepIds: ["reproduce"],
              status: "doing",
            },
            source,
            later,
          );
          expect(() =>
            second.update(
              {
                taskId: stale.id,
                expectedVersion: stale.version,
                patch: { title: "Old session edit" },
                note: "An outdated edit",
              },
              { actor: "ai", threadId: "second", environmentId: "local" },
              later,
            ),
          ).toThrow("Another session updated this task");
          expect(second.get({ taskId: created.id })).toMatchObject({
            task: { version: 2, nextStep: "Implement the fix", tags: ["bug"] },
            events: [{ note: "Reproduced the save failure" }, { note: "建立任务" }],
          });
          second.progress(
            {
              taskId: created.id,
              expectedVersion: changed.version,
              note: "Read the current record and resumed",
              nextStep: "Verify the fix",
            },
            { actor: "ai", threadId: "second", environmentId: "local" },
            later,
          );
          expect(first.get({ taskId: created.id }).task.threads).toEqual([
            { threadId: "first", environmentId: "local" },
            { threadId: "second", environmentId: "local" },
          ]);
        } finally {
          first.close();
          second.close();
        }
        const reopened = new SharedTaskStore(dbPath);
        try {
          const restored = reopened.get({ taskId: "task", historyLimit: 2 });
          expect(restored.task).toMatchObject({
            version: 3,
            nextStep: "Verify the fix",
            steps: [
              {
                assignee: "Diagnostics",
                thread: { threadId: "first", environmentId: "local" },
                status: "done",
              },
            ],
          });
          expect(restored.events).toHaveLength(2);
          expect(restored.hasMoreHistory).toBe(true);
          expect(reopened.list({ projectId: "project", query: "save" })).toMatchObject({
            revision: 3,
            total: 1,
            tasks: [{ id: "task", completedSteps: 1, stepCount: 1 }],
          });
        } finally {
          reopened.close();
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("tracks assignees independently while preserving peer links and step progress", () => {
    const store = new SharedTaskStore(":memory:");
    const secondSource = { ...source, threadId: "second" };
    try {
      const task = store.create(
        {
          title: "Coordinate a fix",
          steps: [
            {
              id: "implement",
              title: "Implement",
              status: "todo",
              assignee: "Implementation",
              thread: { threadId: "first", environmentId: "local" },
            },
            {
              id: "verify",
              title: "Verify",
              status: "todo",
              assignee: "Verification",
              thread: { threadId: "second", environmentId: "local" },
            },
          ],
        },
        source,
        { id: "team", now },
      );
      const implementation = store.progress(
        {
          taskId: task.id,
          expectedVersion: 1,
          startedStepIds: ["implement"],
          note: "Started the implementation",
        },
        source,
        later,
      );
      expect(implementation.status).toBe("doing");
      expect(store.list().tasks[0]?.threads).toEqual([
        { threadId: "first", environmentId: "local" },
        { threadId: "second", environmentId: "local" },
      ]);
      expect(() =>
        store.progress(
          {
            taskId: task.id,
            expectedVersion: 1,
            startedStepIds: ["verify"],
            note: "Stale verification update",
          },
          secondSource,
          later,
        ),
      ).toThrow("Another session updated this task");
      store.progress(
        {
          taskId: task.id,
          expectedVersion: 2,
          startedStepIds: ["verify"],
          note: "Prepared verification from the latest record",
        },
        secondSource,
        later,
      );
      const implemented = store.progress(
        {
          taskId: task.id,
          expectedVersion: 3,
          completedStepIds: ["implement"],
          note: "Implemented and checked the change",
        },
        source,
        later,
      );
      expect(implemented.steps).toEqual([
        {
          id: "implement",
          title: "Implement",
          status: "done",
          assignee: "Implementation",
          thread: { threadId: "first", environmentId: "local" },
        },
        {
          id: "verify",
          title: "Verify",
          status: "doing",
          assignee: "Verification",
          thread: { threadId: "second", environmentId: "local" },
        },
      ]);
      expect(store.list().tasks[0]?.assignees).toEqual([
        { assignee: "Implementation", stepCount: 1, completedSteps: 1, doingSteps: 0 },
        { assignee: "Verification", stepCount: 1, completedSteps: 0, doingSteps: 1 },
      ]);
      expect(() =>
        store.progress(
          {
            taskId: task.id,
            expectedVersion: 4,
            startedStepIds: ["implement"],
            note: "Restarting completed work",
          },
          source,
          later,
        ),
      ).toThrow("Check the task steps and blocker");
      const verified = store.progress(
        {
          taskId: task.id,
          expectedVersion: 4,
          completedStepIds: ["verify"],
          note: "Verification passed",
        },
        secondSource,
        later,
      );
      expect(verified.status).toBe("doing");
      expect(verified.steps.every((step) => step.status === "done")).toBe(true);
      expect(store.get({ taskId: task.id }).events[0]?.source.threadId).toBe("second");
    } finally {
      store.close();
    }
  });

  it("requires completed steps and a cleared blocker, and supports archive and reopening", () => {
    const store = new SharedTaskStore(":memory:");
    try {
      const task = store.create(
        {
          title: "Finish work",
          steps: [{ id: "verify", title: "Verify", status: "todo" }],
        },
        source,
        { id: "task", now },
      );
      expect(() =>
        store.update(
          {
            taskId: task.id,
            expectedVersion: 1,
            patch: { status: "done" },
            note: "Turn ended",
          },
          source,
          later,
        ),
      ).toThrow("Check the task steps and blocker");
      expect(store.revision()).toBe(1);
      expect(() =>
        store.progress(
          {
            taskId: task.id,
            expectedVersion: 1,
            note: "Invalid step",
            completedStepIds: ["missing"],
          },
          source,
          later,
        ),
      ).toThrow("Check the task steps and blocker");
      expect(() =>
        store.progress(
          {
            taskId: task.id,
            expectedVersion: 1,
            note: "Blocked without a reason",
            status: "blocked",
          },
          source,
          later,
        ),
      ).toThrow("Check the task steps and blocker");
      store.progress(
        {
          taskId: task.id,
          expectedVersion: 1,
          status: "blocked",
          blockedReason: "Need a credential",
          completedStepIds: ["verify"],
          note: "Verification passed; delivery needs a credential",
        },
        source,
        later,
      );
      expect(() =>
        store.progress(
          {
            taskId: task.id,
            expectedVersion: 2,
            status: "done",
            note: "Still blocked",
          },
          source,
          later,
        ),
      ).toThrow("Check the task steps and blocker");
      const done = store.progress(
        {
          taskId: task.id,
          expectedVersion: 2,
          status: "done",
          blockedReason: null,
          nextStep: "",
          note: "Delivered and verified",
        },
        source,
        later,
      );
      expect(done.completedAt).toBe(later);
      const archived = store.update(
        {
          taskId: task.id,
          expectedVersion: done.version,
          patch: { status: "archived" },
          note: "Archive",
        },
        source,
        later,
      );
      expect(store.list().tasks).toHaveLength(0);
      expect(store.list({ includeArchived: true }).tasks).toHaveLength(1);
      const reopened = store.update(
        {
          taskId: task.id,
          expectedVersion: archived.version,
          patch: { status: "doing" },
          note: "Reopen",
        },
        source,
        later,
      );
      expect(reopened.completedAt).toBeNull();
      expect(store.list().tasks).toHaveLength(1);
      expect(store.get({ taskId: task.id }).events).toHaveLength(5);
    } finally {
      store.close();
    }
  });

  it("rejects duplicate steps and returns a typed missing-task error", () => {
    const store = new SharedTaskStore(":memory:");
    try {
      expect(() =>
        store.create(
          {
            title: "Invalid",
            steps: [
              { id: "step", title: "First", status: "todo" },
              { id: "step", title: "Second", status: "todo" },
            ],
          },
          source,
          { id: "invalid", now },
        ),
      ).toThrow("Check the task steps and blocker");
      expect(store.list().total).toBe(0);
      expect(() => store.get({ taskId: "missing" })).toThrow("This task no longer exists");
    } finally {
      store.close();
    }
  });
});
