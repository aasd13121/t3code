import {
  OrchestratorMcpFailure,
  SharedTask,
  SharedTaskCreateInput,
  SharedTaskError,
  SharedTaskGetInput,
  SharedTaskGetResult,
  SharedTaskListInput,
  SharedTaskProgressInput,
  SharedTaskSnapshot,
  SharedTaskUpdateInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SharedTaskService from "../../../sharedTasks/SharedTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const taskDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  SharedTaskService.SharedTaskService,
];
const taskFailure = Schema.Union([SharedTaskError, OrchestratorMcpFailure]);

const SharedTaskListTool = Tool.make("t3_task_list", {
  description:
    "Find persistent task cards across conversations on this environment. Search before creating or resuming work to reuse the same task id. Returns bounded summaries; get a task before updating it.",
  parameters: SharedTaskListInput,
  success: SharedTaskSnapshot,
  failure: taskFailure,
  failureMode: "return",
  dependencies: taskDependencies,
})
  .annotate(Tool.Title, "Find shared tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SharedTaskGetTool = Tool.make("t3_task_get", {
  description:
    "Read a persistent task's goal, steps, assignees and linked conversations, next step, blocker and recent progress history. Keep its version for expectedVersion in updates. Conversation completion does not complete the task.",
  parameters: SharedTaskGetInput,
  success: SharedTaskGetResult,
  failure: taskFailure,
  failureMode: "return",
  dependencies: taskDependencies,
})
  .annotate(Tool.Title, "Read a shared task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const SharedTaskCreateTool = Tool.make("t3_task_create", {
  description:
    "Create a durable task card for work the user wants tracked across sessions. Search for an existing task first. Describe the real goal and actionable next step; include steps only when known. The calling conversation is linked automatically.",
  parameters: SharedTaskCreateInput,
  success: SharedTask,
  failure: taskFailure,
  failureMode: "return",
  dependencies: taskDependencies,
})
  .annotate(Tool.Title, "Create a shared task")
  .annotate(Tool.Destructive, false);

const SharedTaskUpdateTool = Tool.make("t3_task_update", {
  description:
    "Edit a persistent task with a progress note and the version just read. Steps may have an assignee label, a linked thread, and a model (provider instance plus model) that the step should run on; assigning or setting a model does not launch or message an agent. When replacing steps preserve other assignees, threads, models and progress. Only supplied fields change. On conflict, read again and merge your change without overwriting another session's progress. Archive instead of deleting; archived tasks can be reopened.",
  parameters: SharedTaskUpdateInput,
  success: SharedTask,
  failure: taskFailure,
  failureMode: "return",
  dependencies: taskDependencies,
})
  .annotate(Tool.Title, "Update a shared task")
  .annotate(Tool.Destructive, false);

const SharedTaskProgressTool = Tool.make("t3_task_record_progress", {
  description:
    "Record factual progress promptly at a milestone, verification result, blocker, or handoff. Include the actionable next step. Supply startedStepIds for work actually begun and completedStepIds only for finished steps; existing assignees and linked threads are preserved. Update only steps you are responsible for. done requires completed steps and no blocker. On version conflict read again before merging; do not invent progress or close unfinished work.",
  parameters: SharedTaskProgressInput,
  success: SharedTask,
  failure: taskFailure,
  failureMode: "return",
  dependencies: taskDependencies,
})
  .annotate(Tool.Title, "Record shared task progress")
  .annotate(Tool.Destructive, false);

export const SharedTaskToolkit = Toolkit.make(
  SharedTaskListTool,
  SharedTaskGetTool,
  SharedTaskCreateTool,
  SharedTaskUpdateTool,
  SharedTaskProgressTool,
);
