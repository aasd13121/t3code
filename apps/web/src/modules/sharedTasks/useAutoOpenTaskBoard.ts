import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, SharedTaskStatus } from "@t3tools/contracts";
import { useEffect } from "react";

import { getPanelModule } from "../panelModules";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentQuery } from "../../state/query";
import { sharedTaskEnvironment } from "../../state/sharedTasks";

const TASK_BOARD_MODULE_ID = "shared-tasks";

const OPEN_TASK_STATUSES: ReadonlySet<SharedTaskStatus> = new Set([
  "todo",
  "doing",
  "waiting",
  "blocked",
  "paused",
]);

/**
 * Shows the task board on its own once this conversation has work on it: a task
 * linked to this thread, or, on a thread that has not run yet, an in-progress
 * task in the same project. Respects a board the user closed.
 */
export function useAutoOpenTaskBoard(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectId: string | null;
  readonly isFreshThread: boolean;
}): void {
  const environmentId = input.threadRef?.environmentId ?? null;
  const threadId = input.threadRef?.threadId ?? null;
  const threadKey = input.threadRef === null ? null : scopedThreadKey(input.threadRef);
  const isFreshThread = input.isFreshThread;
  const projectId = input.projectId;
  const threadRef = input.threadRef;
  const snapshot = useEnvironmentQuery(
    environmentId === null
      ? null
      : sharedTaskEnvironment.subscribe({ environmentId, input: { limit: 200 } }),
  );
  const tasks = snapshot.data?.tasks ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the right-panel store in step with this thread's tasks
  useEffect(() => {
    if (threadKey === null || threadRef === null || environmentId === null || tasks === null) {
      return;
    }
    const relevant = tasks.some((task) => {
      if (!OPEN_TASK_STATUSES.has(task.status)) return false;
      if (
        threadId !== null &&
        task.threads.some(
          (thread) =>
            thread.threadId === threadId &&
            (thread.environmentId ?? environmentId) === environmentId,
        )
      ) {
        return true;
      }
      return (
        isFreshThread &&
        projectId !== null &&
        task.status === "doing" &&
        task.projectId === projectId
      );
    });
    if (!relevant) return;
    const module = getPanelModule(TASK_BOARD_MODULE_ID);
    if (!module) return;
    useRightPanelStore.getState().openModuleAutomatic(threadRef, module.id, module.title);
  }, [environmentId, isFreshThread, projectId, tasks, threadId, threadKey, threadRef]);
}
