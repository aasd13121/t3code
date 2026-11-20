import {
  SharedTaskError,
  type SharedTask,
  type SharedTaskCreateInput,
  type SharedTaskGetInput,
  type SharedTaskGetResult,
  type SharedTaskListInput,
  type SharedTaskLinkThreadInput,
  type SharedTaskProgressInput,
  type SharedTaskSnapshot,
  type SharedTaskSource,
  type SharedTaskUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerConfig } from "../config.ts";
import { SharedTaskStore } from "./SharedTaskStore.ts";

export class SharedTaskService extends Context.Service<
  SharedTaskService,
  {
    readonly list: (
      input: SharedTaskListInput,
    ) => Effect.Effect<SharedTaskSnapshot, SharedTaskError>;
    readonly get: (
      input: SharedTaskGetInput,
    ) => Effect.Effect<SharedTaskGetResult, SharedTaskError>;
    readonly create: (
      input: SharedTaskCreateInput,
      source: SharedTaskSource,
    ) => Effect.Effect<SharedTask, SharedTaskError>;
    readonly update: (
      input: SharedTaskUpdateInput,
      source: SharedTaskSource,
    ) => Effect.Effect<SharedTask, SharedTaskError>;
    readonly progress: (
      input: SharedTaskProgressInput,
      source: SharedTaskSource,
    ) => Effect.Effect<SharedTask, SharedTaskError>;
    readonly linkThread: (
      input: SharedTaskLinkThreadInput,
    ) => Effect.Effect<SharedTask, SharedTaskError>;
    readonly subscribe: (
      input: SharedTaskListInput,
    ) => Stream.Stream<SharedTaskSnapshot, SharedTaskError>;
  }
>()("t3/sharedTasks/SharedTaskService") {}

const isSharedTaskError = Schema.is(SharedTaskError);
const storageError = (cause: unknown) =>
  isSharedTaskError(cause) ? cause : new SharedTaskError({ reason: "storage", cause });

const makeInDirectory = Effect.fn("SharedTaskService.open")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedDirectory = path.resolve(directory);
  yield* fileSystem
    .makeDirectory(resolvedDirectory, { recursive: true })
    .pipe(Effect.mapError(storageError));
  const store = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new SharedTaskStore(path.join(resolvedDirectory, "tasks.sqlite")),
      catch: storageError,
    }),
    (resource) => Effect.sync(() => resource.close()),
  );
  const revision = yield* SubscriptionRef.make(store.revision());
  const refresh = Effect.fn("SharedTaskService.refresh")(function* () {
    const next = yield* Effect.try({ try: () => store.revision(), catch: storageError });
    if (next !== (yield* SubscriptionRef.get(revision))) yield* SubscriptionRef.set(revision, next);
  });

  // A single watcher also sees CLI writes; a cheap revision check recovers from missed OS events.
  yield* Stream.merge(
    fileSystem.watch(resolvedDirectory).pipe(
      Stream.debounce("150 millis"),
      Stream.catch(() => Stream.empty),
    ),
    Stream.tick("5 seconds"),
  ).pipe(
    Stream.runForEach(() => refresh().pipe(Effect.ignore)),
    Effect.forkScoped,
  );

  const list = Effect.fn("SharedTaskService.list")((input: SharedTaskListInput) =>
    Effect.try({ try: () => store.list(input), catch: storageError }),
  );
  const get = Effect.fn("SharedTaskService.get")((input: SharedTaskGetInput) =>
    Effect.try({ try: () => store.get(input), catch: storageError }),
  );
  const create = Effect.fn("SharedTaskService.create")(
    function* (input: SharedTaskCreateInput, source: SharedTaskSource) {
      const stamp = {
        id: `work-${SecureRandom.uuidV4Unsafe()}`,
        now: DateTime.formatIso(yield* DateTime.now),
      };
      return yield* Effect.try({
        try: () => store.create(input, source, stamp),
        catch: storageError,
      });
    },
    Effect.tap(() => refresh()),
  );
  const update = Effect.fn("SharedTaskService.update")(
    function* (input: SharedTaskUpdateInput, source: SharedTaskSource) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* Effect.try({
        try: () => store.update(input, source, now),
        catch: storageError,
      });
    },
    Effect.tap(() => refresh()),
  );
  const progress = Effect.fn("SharedTaskService.progress")(
    function* (input: SharedTaskProgressInput, source: SharedTaskSource) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* Effect.try({
        try: () => store.progress(input, source, now),
        catch: storageError,
      });
    },
    Effect.tap(() => refresh()),
  );

  const linkThread = Effect.fn("SharedTaskService.linkThread")(
    function* (input: SharedTaskLinkThreadInput) {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* Effect.try({ try: () => store.linkThread(input, now), catch: storageError });
    },
    Effect.tap(() => refresh()),
  );

  return SharedTaskService.of({
    list,
    get,
    create,
    update,
    progress,
    linkThread,
    subscribe: (input) =>
      SubscriptionRef.changes(revision).pipe(
        Stream.mapEffect(() => list(input)),
        Stream.changesWith((before, after) => before.revision === after.revision),
      ),
  });
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const path = yield* Path.Path;
  const configured = yield* Config.option(Config.String("T3CODE_SHARED_TASKS_DIR")).pipe(
    Effect.mapError(storageError),
  );
  return yield* makeInDirectory(
    Option.getOrElse(configured, () => path.join(config.baseDir, "shared-tasks")),
  );
});

export const layer = Layer.effect(SharedTaskService, make);
export const layerDirectory = (directory: string) =>
  Layer.effect(SharedTaskService, makeInDirectory(directory));
