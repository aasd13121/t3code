import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(300));
const Text = Schema.String.check(Schema.isMaxLength(8000));
const Note = TrimmedNonEmptyString.check(Schema.isMaxLength(8000));
const Tags = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(80))).check(
  Schema.isMaxLength(30),
);

export const SharedTaskStatus = Schema.Literals([
  "todo",
  "doing",
  "waiting",
  "blocked",
  "paused",
  "done",
  "archived",
]);
export type SharedTaskStatus = typeof SharedTaskStatus.Type;
export const SharedTaskKind = Schema.Literals(["feature", "research", "ops", "other"]);

export const SharedTaskThread = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  environmentId: Schema.optional(TrimmedNonEmptyString),
});
export type SharedTaskThread = typeof SharedTaskThread.Type;

/** The model a step should run on: a provider instance plus one of its models. */
export const SharedTaskStepModel = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
});
export type SharedTaskStepModel = typeof SharedTaskStepModel.Type;

export const SharedTaskStep = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Title,
  status: Schema.Literals(["todo", "doing", "done"]),
  assignee: Schema.optional(Title),
  thread: Schema.optional(SharedTaskThread),
  model: Schema.optional(SharedTaskStepModel),
});
export type SharedTaskStep = typeof SharedTaskStep.Type;
const Steps = Schema.Array(SharedTaskStep).check(Schema.isMaxLength(100));

export const SharedTaskAssigneeProgress = Schema.Struct({
  assignee: Schema.NullOr(Title),
  stepCount: NonNegativeInt,
  completedSteps: NonNegativeInt,
  doingSteps: NonNegativeInt,
});
export type SharedTaskAssigneeProgress = typeof SharedTaskAssigneeProgress.Type;

export function sharedTaskAssigneeProgress(steps: ReadonlyArray<SharedTaskStep>) {
  const groups = new Map<
    string | null,
    {
      assignee: string | null;
      stepCount: number;
      completedSteps: number;
      doingSteps: number;
    }
  >();
  for (const step of steps) {
    const assignee = step.assignee ?? null;
    const group = groups.get(assignee) ?? {
      assignee,
      stepCount: 0,
      completedSteps: 0,
      doingSteps: 0,
    };
    group.stepCount += 1;
    if (step.status === "done") group.completedSteps += 1;
    if (step.status === "doing") group.doingSteps += 1;
    groups.set(assignee, group);
  }
  return [...groups.values()];
}

export const SharedTaskSource = Schema.Struct({
  actor: Schema.Literals(["user", "ai", "system"]),
  threadId: Schema.optional(TrimmedNonEmptyString),
  environmentId: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(Title),
});
export type SharedTaskSource = typeof SharedTaskSource.Type;

export const SharedTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  version: PositiveInt,
  title: Title,
  goal: Text,
  nextStep: Text,
  status: SharedTaskStatus,
  kind: SharedTaskKind,
  tags: Tags,
  focused: Schema.Boolean,
  projectId: Schema.NullOr(TrimmedNonEmptyString),
  workspaceRoot: Schema.NullOr(TrimmedNonEmptyString),
  blockedReason: Schema.NullOr(Text),
  steps: Steps,
  threads: Schema.Array(SharedTaskThread).check(Schema.isMaxLength(50)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type SharedTask = typeof SharedTask.Type;

export function sharedTaskThreads(task: Pick<SharedTask, "threads" | "steps">) {
  const links = new Map<string, SharedTaskThread>();
  for (const thread of [
    ...task.threads,
    ...task.steps.flatMap((step) => (step.thread ? [step.thread] : [])),
  ]) {
    links.set(JSON.stringify([thread.environmentId ?? null, thread.threadId]), thread);
  }
  return [...links.values()];
}

export const SharedTaskSummary = SharedTask.mapFields(
  Struct.pick([
    "id",
    "version",
    "title",
    "status",
    "kind",
    "tags",
    "focused",
    "projectId",
    "workspaceRoot",
    "updatedAt",
    "threads",
  ]),
).mapFields((fields) => ({
  ...fields,
  threads: Schema.Array(SharedTaskThread).check(Schema.isMaxLength(150)),
  goalExcerpt: Text,
  nextStepExcerpt: Text,
  blockedReason: Schema.NullOr(Text),
  stepCount: NonNegativeInt,
  completedSteps: NonNegativeInt,
  assignees: Schema.Array(SharedTaskAssigneeProgress),
}));
export type SharedTaskSummary = typeof SharedTaskSummary.Type;

export const SharedTaskEvent = Schema.Struct({
  id: PositiveInt,
  taskId: TrimmedNonEmptyString,
  version: PositiveInt,
  createdAt: IsoDateTime,
  note: Text,
  source: SharedTaskSource,
  changedFields: Schema.Array(Schema.String),
});
export type SharedTaskEvent = typeof SharedTaskEvent.Type;

export const SharedTaskListInput = Schema.Struct({
  taskId: Schema.optional(TrimmedNonEmptyString),
  projectId: Schema.optional(TrimmedNonEmptyString),
  statuses: Schema.optional(Schema.Array(SharedTaskStatus).check(Schema.isMaxLength(7))),
  tag: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  focused: Schema.optional(Schema.Boolean),
  threads: Schema.optional(Schema.Array(SharedTaskThread).check(Schema.isMaxLength(1000))),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  includeArchived: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
  offset: Schema.optional(NonNegativeInt),
});
export type SharedTaskListInput = typeof SharedTaskListInput.Type;
export const SharedTaskSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  tasks: Schema.Array(SharedTaskSummary),
  total: NonNegativeInt,
  tags: Schema.optional(Schema.Array(Schema.String)),
});
export type SharedTaskSnapshot = typeof SharedTaskSnapshot.Type;

export const SharedTaskGetInput = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  historyLimit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type SharedTaskGetInput = typeof SharedTaskGetInput.Type;
export const SharedTaskGetResult = Schema.Struct({
  task: SharedTask,
  events: Schema.Array(SharedTaskEvent),
  hasMoreHistory: Schema.Boolean,
});
export type SharedTaskGetResult = typeof SharedTaskGetResult.Type;

export const SharedTaskCreateInput = Schema.Struct({
  title: Title,
  goal: Schema.optional(Text),
  nextStep: Schema.optional(Text),
  kind: Schema.optional(SharedTaskKind),
  tags: Schema.optional(Tags),
  focused: Schema.optional(Schema.Boolean),
  projectId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  steps: Schema.optional(Steps),
});
export type SharedTaskCreateInput = typeof SharedTaskCreateInput.Type;

export const SharedTaskPatch = Schema.Struct({
  title: Schema.optional(Title),
  goal: Schema.optional(Text),
  nextStep: Schema.optional(Text),
  status: Schema.optional(SharedTaskStatus),
  kind: Schema.optional(SharedTaskKind),
  tags: Schema.optional(Tags),
  focused: Schema.optional(Schema.Boolean),
  projectId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workspaceRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  blockedReason: Schema.optional(Schema.NullOr(Text)),
  steps: Schema.optional(Steps),
});
export type SharedTaskPatch = typeof SharedTaskPatch.Type;
export const SharedTaskUpdateInput = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  expectedVersion: PositiveInt,
  patch: SharedTaskPatch,
  note: Note,
});
export type SharedTaskUpdateInput = typeof SharedTaskUpdateInput.Type;

export const SharedTaskLinkThreadInput = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  stepId: Schema.optional(TrimmedNonEmptyString),
  thread: SharedTaskThread,
});
export type SharedTaskLinkThreadInput = typeof SharedTaskLinkThreadInput.Type;

export const SharedTaskProgressInput = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  expectedVersion: PositiveInt,
  note: Note,
  nextStep: Schema.optional(Text),
  status: Schema.optional(SharedTaskStatus),
  blockedReason: Schema.optional(Schema.NullOr(Text)),
  startedStepIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  completedStepIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type SharedTaskProgressInput = typeof SharedTaskProgressInput.Type;

export class SharedTaskError extends Schema.TaggedError<SharedTaskError>()("SharedTaskError", {
  reason: Schema.Literals(["not-found", "conflict", "invalid-state", "storage"]),
  taskId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "This task no longer exists.";
      case "conflict":
        return "Another session updated this task. Read its latest version before saving.";
      case "invalid-state":
        return "Check the task steps and blocker before changing its status.";
      case "storage":
        return "The shared task record could not be read or saved.";
    }
  }
}
