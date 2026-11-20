// oxlint-disable t3code/no-untranslated-copy -- task board copy migration is tracked separately
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { DraftSharedTask } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { sharedTaskEnvironment } from "../../state/sharedTasks";
import { formatEnvironmentQueryError } from "../../state/query";
import { toastManager } from "../../components/ui/toast";

export async function linkSentTaskThread(
  task: DraftSharedTask,
  thread: ScopedThreadRef,
): Promise<void> {
  const result = await runAtomCommand(appAtomRegistry, sharedTaskEnvironment.linkThread, {
    environmentId: task.environmentId as EnvironmentId,
    input: { taskId: task.taskId, ...(task.stepId ? { stepId: task.stepId } : {}), thread },
  });
  if (result._tag === "Failure") {
    const toastId = toastManager.add({
      type: "warning",
      title: "会话已发送，任务关联未保存",
      description: formatEnvironmentQueryError(result.cause),
      timeout: 0,
      actionProps: {
        children: "重试关联",
        onClick: () => {
          toastManager.close(toastId);
          void linkSentTaskThread(task, thread);
        },
      },
    });
  }
}
