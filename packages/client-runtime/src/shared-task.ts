import type { SharedTaskGetResult, SharedTaskStatus } from "@t3tools/contracts";

export const SHARED_TASK_STATUS_LABELS: Record<SharedTaskStatus, string> = {
  todo: "待办",
  doing: "进行中",
  waiting: "等待",
  blocked: "受阻",
  paused: "暂停",
  done: "已完成",
  archived: "已归档",
};

export function sharedTaskResumePrompt(taskId: string, stepId?: string): string {
  return `继续跟进共享任务 ${taskId}。${stepId ? `本会话负责步骤 ${stepId}；先确认该步骤的负责人和关联会话，只推进分配给你的步骤。实际开始时用 startedStepIds，完成并验证后用 completedStepIds 记录该步骤。` : ""}先用 t3_task_get 读取最新目标、步骤、分工、进度历史和下一步，然后继续实际工作。复用这个任务编号；在取得进展、完成验证、遇到阻塞或交接时，用 t3_task_record_progress 及时记录事实和下一步。更新前使用最新 version，发生冲突时重新读取并合并，不覆盖其他会话的分工和进展。任务目标真正完成且验证通过后才标记 done。`;
}

export function sharedTaskMarkdown({ task, events, hasMoreHistory }: SharedTaskGetResult): string {
  return [
    `# ${task.title}`,
    "",
    `任务编号：${task.id}`,
    `状态：${SHARED_TASK_STATUS_LABELS[task.status]}`,
    `更新时间：${task.updatedAt}`,
    `版本：${task.version}`,
    "",
    "## 目标",
    "",
    task.goal,
    "",
    "## 下一步",
    "",
    task.nextStep || "暂无",
    "",
    ...(task.blockedReason ? ["## 阻塞", "", task.blockedReason, ""] : []),
    "## 步骤",
    "",
    ...task.steps.map(
      (step) =>
        `- [${step.status === "done" ? "x" : " "}] ${step.title} · ${SHARED_TASK_STATUS_LABELS[step.status]}${step.assignee ? ` · 负责人：${step.assignee}` : ""}${step.model ? ` · 模型：${step.model.label ?? step.model.model}（${step.model.instanceId}）` : ""}${step.thread ? ` · 会话：${step.thread.environmentId ? step.thread.environmentId + "/" : ""}${step.thread.threadId}` : ""}`,
    ),
    "",
    "## 进度记录",
    "",
    ...(hasMoreHistory
      ? ["这里只导出本次读取的最近 " + events.length + " 条记录；更早的记录仍保存在任务库中。", ""]
      : []),
    ...events.flatMap((event) => [
      `### ${event.createdAt} · ${event.source.actor === "ai" ? "AI" : event.source.actor === "user" ? "用户" : "系统"}`,
      "",
      event.note,
      "",
    ]),
  ].join("\n");
}
