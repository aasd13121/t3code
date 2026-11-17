import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { SharedTaskSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SharedTasks from "./SharedTaskService.ts";
import { SharedTaskStore } from "./SharedTaskStore.ts";

it.effect("pushes committed progress and recovers a write made by another process", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-shared-task-service-",
    });
    return yield* Effect.gen(function* () {
      const tasks = yield* SharedTasks.SharedTaskService;
      const snapshots = yield* Queue.unbounded<SharedTaskSnapshot>();
      yield* tasks.subscribe({}).pipe(
        Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
        Effect.forkScoped,
      );
      expect((yield* Queue.take(snapshots)).revision).toBe(0);
      const created = yield* tasks.create(
        { title: "Continue across sessions", nextStep: "Verify" },
        { actor: "user" },
      );
      const first = yield* Queue.take(snapshots);
      expect(first).toMatchObject({ revision: 1, tasks: [{ id: created.id, version: 1 }] });
      yield* tasks.progress(
        {
          taskId: created.id,
          expectedVersion: created.version,
          note: "Verified a step",
          nextStep: "Deliver",
        },
        { actor: "ai", threadId: "first" },
      );
      expect((yield* Queue.take(snapshots)).tasks[0]).toMatchObject({
        version: 2,
        nextStepExcerpt: "Deliver",
      });
      const external = yield* Effect.acquireRelease(
        Effect.sync(() => new SharedTaskStore(path.join(directory, "tasks.sqlite"))),
        (store) => Effect.sync(() => store.close()),
      );
      yield* Effect.sync(() =>
        external.progress(
          {
            taskId: created.id,
            expectedVersion: 2,
            note: "Resumed using the CLI",
            nextStep: "Check delivery",
          },
          { actor: "ai", threadId: "second" },
          "2026-01-01T00:00:00.000Z",
        ),
      );
      yield* TestClock.adjust("5 seconds");
      expect((yield* Queue.take(snapshots)).tasks[0]).toMatchObject({
        version: 3,
        nextStepExcerpt: "Check delivery",
      });
      expect((yield* tasks.get({ taskId: created.id })).events[0]).toMatchObject({
        note: "Resumed using the CLI",
        source: { actor: "ai", threadId: "second" },
      });
    }).pipe(Effect.provide(SharedTasks.layerDirectory(directory)));
  }).pipe(Effect.provide(NodeServices.layer)),
);
