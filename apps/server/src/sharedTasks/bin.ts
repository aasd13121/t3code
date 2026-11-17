import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  SharedTaskCreateInput,
  SharedTaskError,
  SharedTaskGetInput,
  SharedTaskListInput,
  SharedTaskProgressInput,
  SharedTaskSource,
  SharedTaskUpdateInput,
} from "@t3tools/contracts";
import * as SharedTasks from "./SharedTaskService.ts";

const isSharedTaskError = Schema.is(SharedTaskError);
const decodeInputJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeSource = Schema.decodeUnknownEffect(SharedTaskSource);
const decodeList = Schema.decodeUnknownEffect(SharedTaskListInput);
const decodeGet = Schema.decodeUnknownEffect(SharedTaskGetInput);
const decodeCreate = Schema.decodeUnknownEffect(SharedTaskCreateInput);
const decodeUpdate = Schema.decodeUnknownEffect(SharedTaskUpdateInput);
const decodeProgress = Schema.decodeUnknownEffect(SharedTaskProgressInput);

const { values, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    directory: { type: "string" },
    "input-file": { type: "string" },
    "thread-id": { type: "string" },
    "environment-id": { type: "string" },
    actor: { type: "string", default: "ai" },
  },
});
const operation = positionals[0];
const supported = ["list", "get", "create", "update", "progress"];
const directory =
  values.directory ??
  process.env.T3CODE_SHARED_TASKS_DIR ??
  `${process.env.T3CODE_HOME ?? `${NodeOS.homedir()}/.t3`}/shared-tasks`;
const printResult = (result: unknown) =>
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
const printFailure = (error: unknown) => {
  const taskError = isSharedTaskError(error) ? error : undefined;
  process.stderr.write(
    `${JSON.stringify({ error: taskError?.reason ?? "invalid-input-or-storage", ...(taskError?.taskId ? { taskId: taskError.taskId } : {}) })}\n`,
  );
  process.exitCode = 1;
};

if (positionals.length !== 1 || !supported.includes(operation ?? "")) {
  process.stderr.write(
    "Usage: shared-tasks <list|get|create|update|progress> [--input-file JSON] [--directory PATH] [--thread-id ID] [--environment-id ID]\n",
  );
  process.exitCode = 2;
} else {
  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const inputFile = values["input-file"];
    const inputText = inputFile ? yield* fileSystem.readFileString(inputFile) : "{}";
    const input = yield* decodeInputJson(inputText);
    const source = yield* decodeSource({
      actor: values.actor,
      ...(values["thread-id"] ? { threadId: values["thread-id"] } : {}),
      ...(values["environment-id"] ? { environmentId: values["environment-id"] } : {}),
    });
    const tasks = yield* SharedTasks.SharedTaskService;
    switch (operation) {
      case "list":
        return yield* tasks.list(yield* decodeList(input));
      case "get":
        return yield* tasks.get(yield* decodeGet(input));
      case "create":
        return yield* tasks.create(yield* decodeCreate(input), source);
      case "update":
        return yield* tasks.update(yield* decodeUpdate(input), source);
      default:
        return yield* tasks.progress(yield* decodeProgress(input), source);
    }
  }).pipe(
    Effect.provide(
      SharedTasks.layerDirectory(directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
  await Effect.runPromise(
    program.pipe(
      Effect.tap((result) => Effect.sync(() => printResult(result))),
      Effect.catch((error) => Effect.sync(() => printFailure(error))),
    ),
  );
}
