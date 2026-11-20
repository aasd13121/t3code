import type { SharedTaskStatus, SharedTaskSummary } from "@t3tools/contracts";

const OPEN_TASK_STATUSES: ReadonlySet<SharedTaskStatus> = new Set([
  "todo",
  "doing",
  "waiting",
  "blocked",
  "paused",
]);

/** Thread ids that count as this conversation: its own, plus every thread in its fork tree. */
export function taskBoardFamilyThreadIds(input: {
  readonly threadId: string | null;
  readonly threadTreeRootId: string | null;
  readonly parentThreadId?: string | null;
  readonly threads: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: string;
    readonly lineage: { readonly rootThreadId: string; readonly parentThreadId?: string | null };
  }>;
  readonly environmentId: string;
}): ReadonlySet<string> {
  const family = new Set<string>();
  if (input.threadId !== null) family.add(input.threadId);
  if (input.threadTreeRootId !== null) family.add(input.threadTreeRootId);
  if (input.parentThreadId) family.add(input.parentThreadId);
  for (const thread of input.threads) {
    if (thread.environmentId !== input.environmentId) continue;
    if (input.threadTreeRootId !== null && thread.lineage.rootThreadId === input.threadTreeRootId) {
      family.add(thread.id);
      if (thread.lineage.parentThreadId) family.add(thread.lineage.parentThreadId);
    }
  }
  return family;
}

/** Whether the board has work for this conversation; one task can span several conversations. */
export function taskBoardHasWork(input: {
  readonly tasks: ReadonlyArray<SharedTaskSummary>;
  readonly familyThreadIds: ReadonlySet<string>;
  readonly environmentId: string;
  readonly isFreshThread: boolean;
  readonly projectId: string | null;
}): boolean {
  return input.tasks.some((task) => {
    if (!OPEN_TASK_STATUSES.has(task.status)) return false;
    if (
      task.threads.some(
        (thread) =>
          input.familyThreadIds.has(thread.threadId) &&
          (thread.environmentId ?? input.environmentId) === input.environmentId,
      )
    ) {
      return true;
    }
    return (
      input.isFreshThread &&
      input.projectId !== null &&
      task.status === "doing" &&
      task.projectId === input.projectId
    );
  });
}
