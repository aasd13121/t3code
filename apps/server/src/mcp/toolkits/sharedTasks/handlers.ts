import * as Effect from "effect/Effect";
import * as SharedTaskService from "../../../sharedTasks/SharedTaskService.ts";
import { readCaller } from "../../threadAccess.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SharedTaskToolkit } from "./tools.ts";

const handlers = {
  t3_task_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const service = yield* SharedTaskService.SharedTaskService;
      return yield* service.list(input);
    }),
  ),
  t3_task_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* readCaller();
      const service = yield* SharedTaskService.SharedTaskService;
      return yield* service.get(input);
    }),
  ),
  t3_task_create: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope, caller } = yield* readCaller();
      const service = yield* SharedTaskService.SharedTaskService;
      return yield* service.create(
        { ...input, projectId: input.projectId ?? caller?.projectId },
        {
          actor: "ai",
          environmentId: scope.environmentId,
          ...(scope.thread ? { threadId: scope.thread.threadId } : {}),
          ...(scope.client ? { label: scope.client.label } : {}),
        },
      );
    }),
  ),
  t3_task_update: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const service = yield* SharedTaskService.SharedTaskService;
      return yield* service.update(input, {
        actor: "ai",
        environmentId: scope.environmentId,
        ...(scope.thread ? { threadId: scope.thread.threadId } : {}),
        ...(scope.client ? { label: scope.client.label } : {}),
      });
    }),
  ),
  t3_task_record_progress: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const service = yield* SharedTaskService.SharedTaskService;
      return yield* service.progress(input, {
        actor: "ai",
        environmentId: scope.environmentId,
        ...(scope.thread ? { threadId: scope.thread.threadId } : {}),
        ...(scope.client ? { label: scope.client.label } : {}),
      });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof SharedTaskToolkit.tools>;

export const layer = McpToolAccess.toLayer(SharedTaskToolkit, handlers);
