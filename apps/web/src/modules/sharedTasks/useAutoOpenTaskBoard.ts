import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { getPanelModule } from "../panelModules";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShells } from "../../state/entities";
import { threadFamilies } from "../../state/threads";
import { useEnvironmentQuery } from "../../state/query";
import { sharedTaskEnvironment } from "../../state/sharedTasks";
import { taskBoardFamilyThreadIds, taskBoardHasWork } from "./taskBoardAutoOpen";

const TASK_BOARD_MODULE_ID = "shared-tasks";

/**
 * Opens the task board while this conversation shares a task with another thread
 * in its fork tree, or, on an unstarted thread, an in-progress task of the project.
 * Respects a board the user closed.
 */
export function useAutoOpenTaskBoard(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly projectId: string | null;
  readonly isFreshThread: boolean;
  /** Root of this conversation's fork tree; lineages sharing it belong together. */
  readonly threadTreeRootId: string | null;
  readonly parentThreadId: string | null;
}): void {
  const environmentId = input.threadRef?.environmentId ?? null;
  const threadId = input.threadRef?.threadId ?? null;
  const threadKey = input.threadRef === null ? null : scopedThreadKey(input.threadRef);
  const isFreshThread = input.isFreshThread;
  const projectId = input.projectId;
  const threadRef = input.threadRef;
  const threadTreeRootId = input.threadTreeRootId;
  const shells = useThreadShells(threadRef !== null);
  const family = useEnvironmentQuery(
    environmentId === null || threadId === null || threadTreeRootId === null
      ? null
      : threadFamilies.familyAtom(environmentId, threadId as ThreadId),
  );
  const familyThreadIds = taskBoardFamilyThreadIds({
    threadId,
    threadTreeRootId,
    parentThreadId: input.parentThreadId,
    environmentId: environmentId ?? "",
    threads: [
      ...shells,
      ...(family.data?.threads ?? []).map((thread) => ({
        ...thread,
        environmentId: environmentId ?? "",
      })),
    ],
  });
  const snapshot = useEnvironmentQuery(
    environmentId === null
      ? null
      : sharedTaskEnvironment.subscribe({
          environmentId,
          input: {
            limit: 1,
            statuses: ["todo", "doing", "waiting", "blocked", "paused"],
            threads: [...familyThreadIds].sort().map((threadId) => ({ threadId, environmentId })),
          },
        }),
  );
  const projectSnapshot = useEnvironmentQuery(
    environmentId === null || !isFreshThread || projectId === null
      ? null
      : sharedTaskEnvironment.subscribe({
          environmentId,
          input: { projectId, statuses: ["doing"], limit: 1 },
        }),
  );
  const tasks = [...(snapshot.data?.tasks ?? []), ...(projectSnapshot.data?.tasks ?? [])];
  const hasWork = taskBoardHasWork({
    tasks,
    familyThreadIds,
    environmentId: environmentId ?? "",
    isFreshThread,
    projectId,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the right-panel store in step with this thread's tasks
  useEffect(() => {
    if (threadKey === null || threadRef === null || !hasWork) {
      return;
    }
    const module = getPanelModule(TASK_BOARD_MODULE_ID);
    if (!module) return;
    useRightPanelStore.getState().openModuleAutomatic(threadRef, module.id, module.title);
  }, [hasWork, threadKey, threadRef]);
}
