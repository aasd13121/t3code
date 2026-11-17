import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createSharedTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const get = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:shared-tasks:get",
    tag: WS_METHODS.sharedTasksGet,
    staleTimeMs: 0,
  });
  return {
    get,
    subscribe: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:shared-tasks:subscribe",
      tag: WS_METHODS.sharedTasksSubscribe,
      idleTtlMs: 0,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared-tasks:create",
      tag: WS_METHODS.sharedTasksCreate,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared-tasks:update",
      tag: WS_METHODS.sharedTasksUpdate,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.taskId}`,
      },
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(get({ environmentId, input: { taskId: input.taskId } })),
        ),
    }),
    progress: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:shared-tasks:progress",
      tag: WS_METHODS.sharedTasksProgress,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.taskId}`,
      },
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(get({ environmentId, input: { taskId: input.taskId } })),
        ),
    }),
  };
}
