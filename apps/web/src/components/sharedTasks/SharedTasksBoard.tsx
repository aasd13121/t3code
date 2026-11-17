import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  SHARED_TASK_STATUS_LABELS,
  sharedTaskMarkdown,
  sharedTaskResumePrompt,
} from "@t3tools/client-runtime/shared-task";
import { createModelSelection } from "@t3tools/shared/model";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScopedThreadRef,
  SharedTask,
  SharedTaskCreateInput,
  SharedTaskPatch,
  SharedTaskProgressInput,
  SharedTaskStatus,
  SharedTaskStep,
  SharedTaskSummary,
  SharedTaskThread,
  ThreadId,
} from "@t3tools/contracts";
import { sharedTaskAssigneeProgress } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CheckCheckIcon,
  DownloadIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import * as SecureRandom from "effect/crypto/SecureRandom";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useQuietThreadShells } from "../../state/entities";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { sharedTaskEnvironment } from "../../state/sharedTasks";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";

const statusLabels = SHARED_TASK_STATUS_LABELS;
const kindLabels = { feature: "功能开发", research: "研究", ops: "维护", other: "其他" } as const;
const activeStatuses: ReadonlyArray<SharedTaskStatus> = [
  "todo",
  "doing",
  "waiting",
  "blocked",
  "paused",
];
const dateLabel = (iso: string) => new Date(iso).toLocaleString();
const normalizePath = (path: string) =>
  path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
const parseTags = (value: string) =>
  [
    ...new Set(
      value
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ].slice(0, 30);
const taskThreadKey = (thread: SharedTaskThread | undefined, environmentId: EnvironmentId) =>
  thread ? JSON.stringify([thread.environmentId ?? environmentId, thread.threadId]) : "none";

function StatusBadge({ status }: { status: SharedTaskStatus }) {
  return (
    <span
      className={
        status === "blocked"
          ? "rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
          : status === "done"
            ? "rounded-md bg-primary/10 px-2 py-1 text-xs text-primary"
            : "rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
      }
    >
      {statusLabels[status]}
    </span>
  );
}

function TaskBoardFrame({ panel, children }: { panel: boolean; children: ReactNode }) {
  return panel ? (
    <section aria-label="共享任务板" className="flex h-full min-h-0 min-w-0 flex-col">
      {children}
    </section>
  ) : (
    <SidebarInset>{children}</SidebarInset>
  );
}

function TaskBoardContent({ panel, children }: { panel: boolean; children: ReactNode }) {
  return panel ? (
    <div className="space-y-4 p-3">{children}</div>
  ) : (
    <WorkspacePageContainer width="expanded">{children}</WorkspacePageContainer>
  );
}

export function SharedTasksBoard(search: {
  environmentId?: EnvironmentId;
  taskId?: string;
  mode: "page" | "panel";
  projectId?: ProjectId | null;
}) {
  const navigate = useNavigate();
  const panel = search.mode === "panel";
  const [panelTaskId, setPanelTaskId] = useState<string | undefined>(search.taskId);
  const selectedTaskId = panel ? panelTaskId : search.taskId;
  const queryId = useId();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId =
    search.environmentId ?? primaryEnvironmentId ?? environments[0]?.environmentId ?? null;
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [status, setStatus] = useState("active");
  const [tag, setTag] = useState("all");
  const [focusedOnly, setFocusedOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SharedTask | null>(null);
  const [pendingTask, setPendingTask] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const snapshot = useEnvironmentQuery(
    environmentId === null
      ? null
      : sharedTaskEnvironment.subscribe({
          environmentId,
          input: {
            includeArchived: true,
            limit: 200,
            ...(query.trim() ? { query: query.trim() } : {}),
          },
        }),
  );
  const canCreate = useAtomValue(sharedTaskEnvironment.create.permissionAtom(environmentId));
  const canUpdate = useAtomValue(sharedTaskEnvironment.update.permissionAtom(environmentId));
  const update = useAtomCommand(sharedTaskEnvironment.update);
  const tasks = snapshot.data?.tasks ?? [];
  const tags = [...new Set(tasks.flatMap((task) => task.tags))].sort();
  const visible = tasks.filter(
    (task) =>
      (status === "all"
        ? task.status !== "archived"
        : status === "active"
          ? activeStatuses.includes(task.status)
          : task.status === status) &&
      (!focusedOnly || task.focused) &&
      (tag === "all" || task.tags.includes(tag)),
  );
  const selectedVersion = tasks.find((task) => task.id === selectedTaskId)?.version;
  const selectTask = (taskId?: string) => {
    if (environmentId === null) return;
    if (panel) {
      setPanelTaskId(taskId);
      return;
    }
    void navigate({ to: "/tasks", search: { environmentId, ...(taskId ? { taskId } : {}) } });
  };
  const toggleFocus = async (task: SharedTaskSummary) => {
    if (environmentId === null || pendingTask !== null) return;
    setPendingTask(task.id);
    setError(null);
    try {
      const result = await update({
        environmentId,
        input: {
          taskId: task.id,
          expectedVersion: task.version,
          patch: { focused: !task.focused },
          note: task.focused ? "取消关注" : "关注任务",
        },
      });
      if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
    } finally {
      setPendingTask(null);
    }
  };
  return (
    <TaskBoardFrame panel={panel}>
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        {panel ? null : <SidebarTrigger />}
        <ListTodoIcon aria-hidden="true" className="size-5 text-muted-foreground" />
        <h1 className="min-w-0 flex-1 text-base font-semibold">{panel ? "任务板" : "任务"}</h1>
        <Button variant="outline" size="sm" onClick={snapshot.refresh} aria-label="刷新任务">
          <RefreshCwIcon aria-hidden="true" />
          刷新
        </Button>
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          disabled={!canCreate || environmentId === null}
        >
          <PlusIcon aria-hidden="true" />
          新建任务
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <TaskBoardContent panel={panel}>
          <div>
            <h2 className="text-xl font-semibold">持续跟进</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              任务独立保存。切换会话后，目标、进度和下一步仍在这里。
            </p>
          </div>
          <div
            className={
              panel ? "grid grid-cols-2 gap-3" : "grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            }
          >
            {panel ? null : (
              <div className="space-y-1.5">
                <Label>环境</Label>
                <Select
                  value={environmentId ?? ""}
                  onValueChange={(value) => {
                    if (value)
                      void navigate({
                        to: "/tasks",
                        search: { environmentId: value as EnvironmentId },
                      });
                  }}
                >
                  <SelectTrigger aria-label="任务所在环境">
                    <SelectValue placeholder="选择环境" />
                  </SelectTrigger>
                  <SelectPopup>
                    {environments.map((env) => (
                      <SelectItem key={env.environmentId} value={env.environmentId}>
                        {env.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            )}
            <form
              className={panel ? "col-span-2 space-y-1.5" : "space-y-1.5"}
              onSubmit={(event) => {
                event.preventDefault();
                setQuery(queryDraft.trim());
              }}
            >
              <Label htmlFor={queryId}>搜索</Label>
              <div className="flex gap-2">
                <Input
                  id={queryId}
                  value={queryDraft}
                  onChange={(event) => {
                    setQueryDraft(event.target.value.slice(0, 300));
                    if (!event.target.value.trim()) setQuery("");
                  }}
                  placeholder="标题或目标，按回车搜索"
                />
                <Button type="submit" variant="outline" size="sm">
                  搜索
                </Button>
              </div>
            </form>
            <div className="space-y-1.5">
              <Label>状态</Label>
              <Select value={status} onValueChange={(value) => setStatus(value ?? "active")}>
                <SelectTrigger aria-label="筛选任务状态">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="active">正在跟进</SelectItem>
                  <SelectItem value="all">全部未归档</SelectItem>
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>标签</Label>
              <Select value={tag} onValueChange={(value) => setTag(value ?? "all")}>
                <SelectTrigger aria-label="筛选任务标签">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="all">全部标签</SelectItem>
                  {tags.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {visible.length} 项任务{snapshot.isPending ? " · 正在同步" : ""}
            </p>
            <Button
              size="sm"
              variant={focusedOnly ? "secondary" : "ghost"}
              aria-pressed={focusedOnly}
              onClick={() => setFocusedOnly(!focusedOnly)}
            >
              <PinIcon aria-hidden="true" />
              只看关注
            </Button>
          </div>
          {error || snapshot.error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
            >
              {error ?? snapshot.error}
            </p>
          ) : null}
          {environmentId === null ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              连接一个环境后即可管理任务。
            </p>
          ) : snapshot.data === null && snapshot.isPending ? (
            <p role="status" className="py-10 text-center text-sm text-muted-foreground">
              正在读取任务…
            </p>
          ) : visible.length === 0 ? (
            <div className="rounded-xl border border-dashed p-10 text-center">
              <ListTodoIcon aria-hidden="true" className="mx-auto size-8 text-muted-foreground" />
              <h3 className="mt-4 font-medium">
                {tasks.length ? "没有符合筛选条件的任务" : "从一个需要持续跟进的目标开始"}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                保存目标和下一步，让后续会话接着工作。
              </p>
              {tasks.length === 0 ? (
                <div className="mt-5">
                  <Button onClick={() => setCreating(true)} disabled={!canCreate}>
                    新建任务
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className={panel ? "grid gap-3" : "grid gap-4 lg:grid-cols-2"}>
              {visible.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  canUpdate={canUpdate}
                  pending={pendingTask === task.id}
                  onOpen={() => selectTask(task.id)}
                  onFocus={() => void toggleFocus(task)}
                />
              ))}
            </div>
          )}
          {snapshot.data && snapshot.data.total > tasks.length ? (
            <p className="text-sm text-muted-foreground">
              已加载最近 {tasks.length} 项。搜索标题或目标可以查找更早的任务。
            </p>
          ) : null}
          {!canCreate && environmentId !== null ? (
            <p className="text-sm text-muted-foreground">
              当前连接可查看任务。记录进度需要此环境的操作权限。
            </p>
          ) : null}
        </TaskBoardContent>
      </ScrollArea>
      {environmentId !== null && selectedTaskId ? (
        <TaskDetail
          key={environmentId + ":" + selectedTaskId}
          environmentId={environmentId}
          taskId={selectedTaskId}
          summaryVersion={selectedVersion}
          onClose={() => selectTask()}
          onThreadOpened={panel ? () => selectTask() : undefined}
          onEdit={setEditing}
        />
      ) : null}
      {environmentId !== null && (creating || editing) ? (
        <TaskEditor
          key={environmentId + ":" + (editing?.id ?? "create")}
          environmentId={environmentId}
          task={editing}
          defaultProjectId={search.projectId}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={(task) => {
            setCreating(false);
            setEditing(null);
            selectTask(task.id);
          }}
        />
      ) : null}
    </TaskBoardFrame>
  );
}

function TaskCard({
  task,
  canUpdate,
  pending,
  onOpen,
  onFocus,
}: {
  task: SharedTaskSummary;
  canUpdate: boolean;
  pending: boolean;
  onOpen: () => void;
  onFocus: () => void;
}) {
  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 rounded text-left font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="line-clamp-2 break-words">{task.title}</span>
        </button>
        <StatusBadge status={task.status} />
      </div>
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="mb-1 text-xs text-muted-foreground">目标</dt>
          <dd className="line-clamp-3 whitespace-pre-wrap break-words">
            {task.goalExcerpt || "尚未填写"}
          </dd>
        </div>
        <div>
          <dt className="mb-1 text-xs text-muted-foreground">下一步</dt>
          <dd className="line-clamp-3 whitespace-pre-wrap break-words">
            {task.nextStepExcerpt || (task.status === "done" ? "目标已完成" : "尚未填写")}
          </dd>
        </div>
      </dl>
      {task.blockedReason ? (
        <p className="line-clamp-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {task.blockedReason}
        </p>
      ) : null}
      <div className="mt-auto space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {task.stepCount
              ? "步骤 " + task.completedSteps + " / " + task.stepCount
              : "尚未设置步骤"}
          </span>
          <span>{kindLabels[task.kind]}</span>
        </div>
        {task.stepCount > 0 ? (
          <div
            role="progressbar"
            aria-label="任务步骤进度"
            aria-valuemin={0}
            aria-valuemax={task.stepCount}
            aria-valuenow={task.completedSteps}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: (task.completedSteps / task.stepCount) * 100 + "%" }}
            />
          </div>
        ) : null}
      </div>
      {task.tags.length ? (
        <div className="flex flex-wrap gap-1.5">
          {task.tags.map((value) => (
            <span
              key={value}
              className="max-w-full truncate rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {value}
            </span>
          ))}
        </div>
      ) : null}
      {task.assignees.some((group) => group.assignee !== null) ? (
        <div
          className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
          aria-label="任务分工进度"
        >
          {task.assignees.map((group) => (
            <span key={JSON.stringify(group.assignee)}>
              {group.assignee ?? "未分配"} · {group.completedSteps}/{group.stepCount}
              {group.doingSteps ? ` · ${group.doingSteps} 进行中` : ""}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {dateLabel(task.updatedAt)}
        </span>
        <div className="flex shrink-0 gap-2">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={task.focused ? "取消关注任务" : "关注任务"}
            aria-pressed={task.focused}
            disabled={!canUpdate || pending}
            onClick={onFocus}
          >
            <PinIcon aria-hidden="true" />
          </Button>
          <Button size="sm" variant="outline" onClick={onOpen}>
            详情与跟进
          </Button>
        </div>
      </div>
    </article>
  );
}

function TaskDetail({
  environmentId,
  taskId,
  summaryVersion,
  onClose,
  onThreadOpened,
  onEdit,
}: {
  environmentId: EnvironmentId;
  taskId: string;
  summaryVersion: number | undefined;
  onClose: () => void;
  onThreadOpened?: (() => void) | undefined;
  onEdit: (task: SharedTask) => void;
}) {
  const [historyLimit, setHistoryLimit] = useState(10);
  const detail = useEnvironmentQuery(
    sharedTaskEnvironment.get({
      environmentId,
      input: { taskId, ...(historyLimit === 100 ? { historyLimit } : {}) },
    }),
  );
  const canUpdate = useAtomValue(sharedTaskEnvironment.update.permissionAtom(environmentId));
  const update = useAtomCommand(sharedTaskEnvironment.update);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [stepTitle, setStepTitle] = useState("");
  const [assigningStepId, setAssigningStepId] = useState<string | null>(null);
  const [modelStepId, setModelStepId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const newThread = useNewThreadHandler();
  const { copyToClipboard } = useCopyToClipboard();
  const task = detail.data?.task;
  const openThread = async (threadRef: ScopedThreadRef) => {
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
    onThreadOpened?.();
  };
  const selectedProject =
    projects.find((project) => project.id === (projectId ?? task?.projectId)) ??
    projects.find(
      (project) =>
        task?.workspaceRoot &&
        normalizePath(project.workspaceRoot) === normalizePath(task.workspaceRoot),
    );
  const detailVersion = task?.version;
  const refreshDetail = detail.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- task pushes invalidate the separately fetched detail and history
  useEffect(() => {
    if (
      summaryVersion !== undefined &&
      detailVersion !== undefined &&
      detailVersion !== summaryVersion
    )
      refreshDetail();
  }, [summaryVersion, detailVersion, refreshDetail]);
  const mutate = async (patch: SharedTaskPatch, note: string) => {
    if (!task || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await update({
        environmentId,
        input: { taskId, expectedVersion: task.version, patch, note },
      });
      if (result._tag === "Failure") {
        setError(formatEnvironmentQueryError(result.cause));
        detail.refresh();
      } else {
        setStepTitle("");
        detail.refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  const startNewThread = async () => {
    if (!task || !selectedProject || busy) return;
    setBusy(true);
    setError(null);
    try {
      const started = await newThread(scopeProjectRef(environmentId, selectedProject.id), {
        prompt: sharedTaskResumePrompt(task.id),
      });
      if (started) onThreadOpened?.();
      else setError("会话未创建。请确认项目仍可用。");
    } finally {
      setBusy(false);
    }
  };
  const launchingPhaseRef = useRef(false);
  const launchPhase = async (step: SharedTaskStep) => {
    if (!task || !step.model || !selectedProject || busy || launchingPhaseRef.current) return;
    launchingPhaseRef.current = true;
    setError(null);
    try {
      const started = await newThread(scopeProjectRef(environmentId, selectedProject.id), {
        prompt: sharedTaskResumePrompt(task.id, step.id),
      });
      if (!started) {
        setError("会话未创建。请确认项目仍可用。");
        return;
      }
      useComposerDraftStore.getState().setModelSelection(
        started.draftId,
        createModelSelection(step.model.instanceId as ProviderInstanceId, step.model.model),
        { replaceOptions: true },
      );
      await mutate(
        {
          steps: task.steps.map((value) =>
            value.id === step.id
              ? {
                  ...value,
                  status: "doing",
                  thread: { threadId: started.threadId, environmentId },
                }
              : value,
          ),
          ...(task.status === "todo" ? { status: "doing" } : {}),
        },
        "开始阶段（模型 " + (step.model.label ?? step.model.model) + "）：" + step.title,
      );
      onThreadOpened?.();
    } finally {
      launchingPhaseRef.current = false;
    }
  };
  const exportRecord = () => {
    if (!detail.data) return;
    const url = URL.createObjectURL(
      new Blob([sharedTaskMarkdown(detail.data)], { type: "text/markdown;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = taskId + ".md";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{task?.title ?? "任务详情"}</DialogTitle>
          <DialogDescription>同一项任务的目标、步骤和跨会话进度。</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {detail.error || error ? (
            <p role="alert" className="mb-4 text-sm text-destructive">
              {error ?? detail.error}
            </p>
          ) : null}
          {!task ? (
            <p role="status" className="py-8 text-sm text-muted-foreground">
              {detail.isPending ? "正在读取任务…" : "任务暂不可用。"}
            </p>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge status={task.status} />
                <span className="text-xs text-muted-foreground">
                  更新于 {dateLabel(task.updatedAt)}
                </span>
              </div>
              <dl className="space-y-4 text-sm">
                <div>
                  <dt className="mb-1 font-medium">目标</dt>
                  <dd className="whitespace-pre-wrap break-words">{task.goal || "尚未填写"}</dd>
                </div>
                <div>
                  <dt className="mb-1 font-medium">下一步</dt>
                  <dd className="whitespace-pre-wrap break-words">{task.nextStep || "尚未填写"}</dd>
                </div>
                {task.blockedReason ? (
                  <div>
                    <dt className="mb-1 font-medium text-destructive">阻塞原因</dt>
                    <dd className="whitespace-pre-wrap break-words text-destructive">
                      {task.blockedReason}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {task.steps.length ? (
                <section className="space-y-3" aria-label="协作进度">
                  <h3 className="text-sm font-medium">分工进度</h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {sharedTaskAssigneeProgress(task.steps).map((group) => (
                      <div
                        key={JSON.stringify(group.assignee)}
                        className="space-y-1 rounded-lg border p-3 text-sm"
                      >
                        <p className="break-words font-medium">{group.assignee ?? "未分配"}</p>
                        <p className="text-xs text-muted-foreground">
                          已完成 {group.completedSteps}/{group.stepCount} · 进行中{" "}
                          {group.doingSteps}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              <section className="space-y-3" aria-label="任务步骤">
                <h3 className="text-sm font-medium">
                  步骤 · {task.steps.filter((step) => step.status === "done").length} /{" "}
                  {task.steps.length}
                </h3>
                {task.steps.map((step) => (
                  <div
                    key={step.id}
                    className="space-y-3 rounded-lg border p-3 text-sm"
                    role="group"
                    aria-label={"步骤：" + step.title}
                  >
                    <div className="flex items-start gap-3">
                      <label className="flex min-w-0 flex-1 items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-1 size-4 accent-primary"
                          aria-label={"完成步骤：" + step.title}
                          checked={step.status === "done"}
                          disabled={!canUpdate || busy}
                          onChange={(event) =>
                            void mutate(
                              {
                                steps: task.steps.map((value) =>
                                  value.id === step.id
                                    ? { ...value, status: event.target.checked ? "done" : "todo" }
                                    : value,
                                ),
                                ...(!event.target.checked && task.status === "done"
                                  ? { status: "doing" }
                                  : {}),
                              },
                              (event.target.checked ? "完成步骤：" : "重新打开步骤：") + step.title,
                            )
                          }
                        />
                        <span className="min-w-0 break-words">{step.title}</span>
                      </label>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {statusLabels[step.status]}
                      </span>
                    </div>
                    <p className="break-words text-xs text-muted-foreground">
                      负责人：{step.assignee ?? "未分配"}
                      {step.model ? ` · 模型：${step.model.label ?? step.model.model}` : ""}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {step.status === "todo" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canUpdate || busy}
                          onClick={() =>
                            void mutate(
                              {
                                steps: task.steps.map((value) =>
                                  value.id === step.id ? { ...value, status: "doing" } : value,
                                ),
                                ...(task.status === "todo" ? { status: "doing" } : {}),
                              },
                              "开始步骤：" + step.title,
                            )
                          }
                        >
                          开始步骤
                        </Button>
                      ) : null}
                      {step.model && !step.thread && step.status !== "done" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canUpdate || busy || !selectedProject}
                          onClick={() => void launchPhase(step)}
                        >
                          <PlayIcon aria-hidden="true" />
                          开始此阶段
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canUpdate || busy}
                        onClick={() =>
                          setAssigningStepId(assigningStepId === step.id ? null : step.id)
                        }
                      >
                        设置分工
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canUpdate || busy}
                        onClick={() => setModelStepId(modelStepId === step.id ? null : step.id)}
                      >
                        设置模型
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => copyToClipboard(sharedTaskResumePrompt(task.id, step.id))}
                      >
                        复制步骤指令
                      </Button>
                      {step.thread ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (!step.thread) return;
                            void openThread(
                              scopeThreadRef(
                                (step.thread.environmentId ?? environmentId) as EnvironmentId,
                                step.thread.threadId as ThreadId,
                              ),
                            );
                          }}
                        >
                          <MessageSquareIcon aria-hidden="true" />
                          打开负责人会话
                        </Button>
                      ) : null}
                    </div>
                    {assigningStepId === step.id ? (
                      <TaskStepAssignmentForm
                        key={step.id}
                        environmentId={environmentId}
                        task={task}
                        step={step}
                        onRefresh={detail.refresh}
                        onClose={() => setAssigningStepId(null)}
                        onSaved={() => {
                          setAssigningStepId(null);
                          detail.refresh();
                        }}
                      />
                    ) : null}
                    {modelStepId === step.id ? (
                      <TaskStepModelForm
                        key={step.id}
                        environmentId={environmentId}
                        task={task}
                        step={step}
                        onRefresh={detail.refresh}
                        onClose={() => setModelStepId(null)}
                        onSaved={() => {
                          setModelStepId(null);
                          detail.refresh();
                        }}
                      />
                    ) : null}
                  </div>
                ))}
                {canUpdate && task.steps.length < 100 ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (stepTitle.trim())
                        void mutate(
                          {
                            steps: [
                              ...task.steps,
                              {
                                id: SecureRandom.uuidV4Unsafe(),
                                title: stepTitle.trim(),
                                status: "todo",
                              },
                            ],
                            ...(task.status === "done" ? { status: "doing" } : {}),
                          },
                          "新增步骤：" + stepTitle.trim(),
                        );
                    }}
                  >
                    <Input
                      aria-label="新增步骤名称"
                      value={stepTitle}
                      onChange={(event) => setStepTitle(event.target.value.slice(0, 300))}
                      placeholder="添加下一项实际步骤"
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      size="sm"
                      disabled={busy || !stepTitle.trim()}
                    >
                      添加
                    </Button>
                  </form>
                ) : null}
              </section>
              <section className="space-y-3" aria-label="继续跟进任务">
                <h3 className="text-sm font-medium">继续跟进</h3>
                <div className="flex flex-wrap gap-2">
                  {task.threads.at(-1) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const thread = task.threads.at(-1)!;
                        void openThread(
                          scopeThreadRef(
                            (thread.environmentId ?? environmentId) as EnvironmentId,
                            thread.threadId as ThreadId,
                          ),
                        );
                      }}
                    >
                      <MessageSquareIcon aria-hidden="true" />
                      回到关联会话
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyToClipboard(sharedTaskResumePrompt(task.id))}
                  >
                    复制跟进指令
                  </Button>
                </div>
                <Select
                  value={selectedProject?.id ?? "none"}
                  onValueChange={(value) => setProjectId(value === "none" ? null : value)}
                >
                  <SelectTrigger aria-label="选择跟进项目">
                    <SelectValue placeholder="选择项目" />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="none">选择跟进项目</SelectItem>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  size="sm"
                  disabled={!canUpdate || !selectedProject || busy}
                  onClick={() => void startNewThread()}
                >
                  <PlayIcon aria-hidden="true" />
                  在新会话跟进
                </Button>
                <p className="text-xs text-muted-foreground">
                  打开会话后发送预填的指令，AI 会读取这项任务并持续更新进度。
                </p>
              </section>
              {canUpdate ? (
                <TaskProgressForm
                  key={task.id}
                  environmentId={environmentId}
                  task={task}
                  onSaved={detail.refresh}
                />
              ) : null}
              <section className="space-y-3" aria-label="任务进度历史">
                <h3 className="text-sm font-medium">进度记录</h3>
                {detail.data?.events.map((event) => (
                  <article key={event.id} className="space-y-2 border-l-2 pl-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="text-xs text-muted-foreground">
                        {dateLabel(event.createdAt)} ·{" "}
                        {event.source.label ??
                          (event.source.actor === "ai"
                            ? "AI"
                            : event.source.actor === "user"
                              ? "用户"
                              : "系统")}
                      </p>
                      {event.source.threadId ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (!event.source.threadId) return;
                            void openThread(
                              scopeThreadRef(
                                (event.source.environmentId ?? environmentId) as EnvironmentId,
                                event.source.threadId as ThreadId,
                              ),
                            );
                          }}
                        >
                          打开记录会话
                        </Button>
                      ) : null}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm">{event.note}</p>
                  </article>
                ))}
                {detail.data?.hasMoreHistory && historyLimit === 10 ? (
                  <Button size="sm" variant="ghost" onClick={() => setHistoryLimit(100)}>
                    显示更多记录
                  </Button>
                ) : null}
                {detail.data?.hasMoreHistory && historyLimit === 100 ? (
                  <p className="text-xs text-muted-foreground">
                    显示最近 100 条记录，更早的记录仍保存在任务库中。
                  </p>
                ) : null}
              </section>
              <p className="break-all text-xs text-muted-foreground">
                任务编号：{task.id} · 版本 {task.version}
              </p>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={!task} onClick={exportRecord}>
            <DownloadIcon aria-hidden="true" />
            导出记录
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!task || !canUpdate || busy}
            onClick={() => {
              if (task) onEdit(task);
            }}
          >
            <PencilIcon aria-hidden="true" />
            编辑
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!task || !canUpdate || busy}
            onClick={() => {
              if (task)
                void mutate(
                  { status: task.status === "archived" ? "todo" : "archived" },
                  task.status === "archived" ? "恢复归档任务" : "归档任务",
                );
            }}
          >
            <ArchiveIcon aria-hidden="true" />
            {task?.status === "archived" ? "恢复" : "归档"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function TaskStepModelForm({
  environmentId,
  task,
  step,
  onClose,
  onSaved,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  task: SharedTask;
  step: SharedTaskStep;
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  const id = useId();
  const [base] = useState({ version: task.version, step });
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    task.projectId as ProjectId | null,
  );
  const [instanceId, setInstanceId] = useState<string>(
    step.model?.instanceId ?? instanceEntries[0]?.instanceId ?? "",
  );
  const [model, setModel] = useState<string>(step.model?.model ?? "");
  const [busy, setBusy] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = useAtomCommand(sharedTaskEnvironment.update);
  const canUpdate = useAtomValue(sharedTaskEnvironment.update.permissionAtom(environmentId));
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    (instanceId || null) as ProviderInstanceId | null,
    model || null,
  );
  const modelOptions = modelOptionsByInstance.get(instanceId as ProviderInstanceId) ?? [];
  const modelChanged =
    instanceId.trim() !== (base.step.model?.instanceId ?? "") ||
    model.trim() !== (base.step.model?.model ?? "");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !modelChanged) return;
    setBusy(true);
    setError(null);
    try {
      const picked = modelOptions.find((option) => option.slug === model.trim()) ?? null;
      const steps = task.steps.map((current) => {
        if (current.id !== step.id) return current;
        const next = { ...current };
        if (model.trim() && instanceId.trim()) {
          next.model = {
            instanceId: instanceId.trim(),
            model: model.trim(),
            ...(picked ? { label: picked.shortName ?? picked.name } : {}),
          };
        } else delete next.model;
        return next;
      });
      const result = await update({
        environmentId,
        input: {
          taskId: task.id,
          expectedVersion: conflicted ? task.version : base.version,
          patch: { steps },
          note: (model.trim() ? "设置步骤模型：" : "清除步骤模型：") + step.title,
        },
      });
      if (result._tag === "Success") onSaved();
      else {
        setConflicted(true);
        onRefresh();
        setError(
          formatEnvironmentQueryError(result.cause) + " 模型选择已保留；检查最新进度后再次保存。",
        );
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-3 border-t pt-3"
      aria-label={"设置步骤模型：" + step.title}
      onSubmit={(event) => void submit(event)}
    >
      <div className="space-y-1.5">
        <Label htmlFor={id + "-instance"}>提供商实例</Label>
        <Select
          value={instanceId}
          onValueChange={(value) => {
            setInstanceId(value ?? "");
            setModel("");
          }}
        >
          <SelectTrigger aria-label="步骤模型提供商">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {instanceEntries
              .filter((entry) => entry.enabled)
              .map((entry) => (
                <SelectItem key={entry.instanceId} value={entry.instanceId}>
                  {entry.displayName}
                </SelectItem>
              ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={id + "-model"}>模型</Label>
        <Select value={model || "none"} onValueChange={(value) => setModel(value === "none" ? "" : (value ?? ""))}>
          <SelectTrigger aria-label="步骤模型">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="none">不指定模型</SelectItem>
            {modelOptions.map((option) => (
              <SelectItem key={option.slug} value={option.slug}>
                {option.shortName ?? option.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button type="submit" disabled={!canUpdate || busy || !modelChanged || !instanceId.trim()}>
          {busy ? "正在保存…" : conflicted ? "按最新版本保存修改" : "保存模型"}
        </Button>
      </div>
    </form>
  );
}

function TaskStepAssignmentForm({
  environmentId,
  task,
  step,
  onClose,
  onSaved,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  task: SharedTask;
  step: SharedTaskStep;
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  const id = useId();
  const [base] = useState({ version: task.version, step });
  const [assignee, setAssignee] = useState(step.assignee ?? "");
  const [thread, setThread] = useState(step.thread);
  const [busy, setBusy] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threads = useQuietThreadShells().filter(
    (value) =>
      value.environmentId === environmentId &&
      value.archivedAt === null &&
      (task.projectId === null || value.projectId === task.projectId),
  );
  const update = useAtomCommand(sharedTaskEnvironment.update);
  const canUpdate = useAtomValue(sharedTaskEnvironment.update.permissionAtom(environmentId));
  const assigneeChanged = assignee.trim() !== (base.step.assignee ?? "");
  const threadChanged =
    taskThreadKey(thread, environmentId) !== taskThreadKey(base.step.thread, environmentId);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || (!assigneeChanged && !threadChanged)) return;
    setBusy(true);
    setError(null);
    try {
      const steps = task.steps.map((current) => {
        if (current.id !== step.id) return current;
        const next = { ...current };
        if (assigneeChanged) {
          if (assignee.trim()) next.assignee = assignee.trim();
          else delete next.assignee;
        }
        if (threadChanged) {
          if (thread) next.thread = thread;
          else delete next.thread;
        }
        return next;
      });
      const result = await update({
        environmentId,
        input: {
          taskId: task.id,
          expectedVersion: conflicted ? task.version : base.version,
          patch: { steps },
          note: "更新步骤分工：" + step.title,
        },
      });
      if (result._tag === "Success") onSaved();
      else {
        setConflicted(true);
        onRefresh();
        setError(
          formatEnvironmentQueryError(result.cause) + " 分工输入已保留；检查最新进度后再次保存。",
        );
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-3 border-t pt-3"
      aria-label={"设置步骤分工：" + step.title}
      onSubmit={(event) => void submit(event)}
    >
      <div className="space-y-1.5">
        <Label htmlFor={id + "-assignee"}>负责人</Label>
        <Input
          id={id + "-assignee"}
          value={assignee}
          onChange={(event) => setAssignee(event.target.value.slice(0, 300))}
          placeholder="例如：实现智能体、测试智能体"
        />
      </div>
      <div className="space-y-1.5">
        <Label>关联智能体会话</Label>
        <Select
          value={taskThreadKey(thread, environmentId)}
          onValueChange={(value) => {
            const selected = threads.find(
              (candidate) =>
                taskThreadKey(
                  { environmentId: candidate.environmentId, threadId: candidate.id },
                  environmentId,
                ) === value,
            );
            if (value === "none") setThread(undefined);
            else if (selected)
              setThread({ environmentId: selected.environmentId, threadId: selected.id });
          }}
        >
          <SelectTrigger aria-label="关联智能体会话">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="none">不关联会话</SelectItem>
            {thread &&
            !threads.some(
              (candidate) =>
                taskThreadKey(
                  { environmentId: candidate.environmentId, threadId: candidate.id },
                  environmentId,
                ) === taskThreadKey(thread, environmentId),
            ) ? (
              <SelectItem value={taskThreadKey(thread, environmentId)}>
                当前关联会话（不在活动列表中）
              </SelectItem>
            ) : null}
            {threads.map((candidate) => (
              <SelectItem
                key={candidate.id}
                value={taskThreadKey(
                  { environmentId: candidate.environmentId, threadId: candidate.id },
                  environmentId,
                )}
              >
                {candidate.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        保存后，复制步骤指令并在负责人会话中发送，智能体即可跟进这一部分。
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={!canUpdate || busy || (!assigneeChanged && !threadChanged)}
        >
          {busy ? "正在保存…" : conflicted ? "按最新版本保存分工" : "保存分工"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
      </div>
    </form>
  );
}

function TaskProgressForm({
  environmentId,
  task,
  onSaved,
}: {
  environmentId: EnvironmentId;
  task: SharedTask;
  onSaved: () => void;
}) {
  const id = useId();
  const [base, setBase] = useState(task);
  const [note, setNote] = useState("");
  const [nextStep, setNextStep] = useState(task.nextStep);
  const [status, setStatus] = useState(task.status);
  const [blocker, setBlocker] = useState(task.blockedReason ?? "");
  const [busy, setBusy] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = useAtomCommand(sharedTaskEnvironment.progress);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!note.trim() || busy) return;
    const input: SharedTaskProgressInput = {
      taskId: task.id,
      expectedVersion: conflicted ? task.version : base.version,
      note: note.trim(),
      ...(nextStep !== base.nextStep ? { nextStep } : {}),
      ...(status !== base.status ? { status } : {}),
      ...(blocker !== (base.blockedReason ?? "") || status === "done"
        ? { blockedReason: status === "done" ? null : blocker.trim() || null }
        : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const result = await progress({ environmentId, input });
      if (result._tag === "Failure") {
        setConflicted(true);
        setError(
          formatEnvironmentQueryError(result.cause) + " 输入已保留；刷新后再次保存只提交你的修改。",
        );
        onSaved();
      } else {
        setBase(result.value);
        setNote("");
        setNextStep(result.value.nextStep);
        setStatus(result.value.status);
        setBlocker(result.value.blockedReason ?? "");
        setConflicted(false);
        onSaved();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 rounded-xl border p-4">
      <h3 className="text-sm font-medium">记录进度</h3>
      <div className="space-y-1.5">
        <Label htmlFor={id + "-note"}>本次进展</Label>
        <Textarea
          id={id + "-note"}
          value={note}
          onChange={(event) => setNote(event.target.value.slice(0, 8000))}
          placeholder="完成了什么、如何验证，或遇到了什么阻塞"
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={id + "-next"}>下一步</Label>
        <Textarea
          id={id + "-next"}
          value={nextStep}
          onChange={(event) => setNextStep(event.target.value.slice(0, 8000))}
        />
      </div>
      <Select
        value={status}
        onValueChange={(value) => {
          if (value) setStatus(value as SharedTaskStatus);
        }}
      >
        <SelectTrigger aria-label="记录后的任务状态">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {Object.entries(statusLabels).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {status === "blocked" ? (
        <div className="space-y-1.5">
          <Label htmlFor={id + "-blocker"}>阻塞原因</Label>
          <Textarea
            id={id + "-blocker"}
            value={blocker}
            onChange={(event) => setBlocker(event.target.value.slice(0, 8000))}
            required
          />
        </div>
      ) : null}
      {status === "done" && task.steps.some((step) => step.status !== "done") ? (
        <p className="text-xs text-muted-foreground">先确认每个步骤已完成，再标记任务完成。</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        size="sm"
        disabled={
          busy ||
          !note.trim() ||
          (status === "blocked" && !blocker.trim()) ||
          (status === "done" && task.steps.some((step) => step.status !== "done"))
        }
      >
        <CheckCheckIcon aria-hidden="true" />
        {busy ? "正在保存…" : conflicted ? "按最新版本保存修改" : "保存进度"}
      </Button>
    </form>
  );
}

function TaskEditor({
  environmentId,
  task,
  defaultProjectId,
  onClose,
  onSaved,
}: {
  environmentId: EnvironmentId;
  task: SharedTask | null;
  defaultProjectId?: ProjectId | null | undefined;
  onClose: () => void;
  onSaved: (task: SharedTask) => void;
}) {
  const id = useId();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [base] = useState(task);
  const [title, setTitle] = useState(task?.title ?? "");
  const [goal, setGoal] = useState(task?.goal ?? "");
  const [nextStep, setNextStep] = useState(task?.nextStep ?? "");
  const [tags, setTags] = useState(task?.tags.join(", ") ?? "");
  const [kind, setKind] = useState<SharedTask["kind"]>(task?.kind ?? "feature");
  const [projectId, setProjectId] = useState(
    task ? (task.projectId ?? "") : (defaultProjectId ?? ""),
  );
  const [steps, setSteps] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useEnvironmentQuery(
    base === null ? null : sharedTaskEnvironment.get({ environmentId, input: { taskId: base.id } }),
  );
  const create = useAtomCommand(sharedTaskEnvironment.create);
  const update = useAtomCommand(sharedTaskEnvironment.update);
  const canSave = useAtomValue(
    (task ? sharedTaskEnvironment.update : sharedTaskEnvironment.create).permissionAtom(
      environmentId,
    ),
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || busy) return;
    const project = projects.find((value) => value.id === projectId);
    const fields = {
      title: title.trim(),
      goal,
      nextStep,
      kind,
      tags: parseTags(tags),
      projectId: projectId || null,
    };
    setBusy(true);
    setError(null);
    try {
      if (base === null) {
        const input: SharedTaskCreateInput = {
          ...fields,
          workspaceRoot: project?.workspaceRoot ?? null,
          steps: steps
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean)
            .slice(0, 100)
            .map((value) => ({ id: SecureRandom.uuidV4Unsafe(), title: value, status: "todo" })),
        };
        const result = await create({ environmentId, input });
        if (result._tag === "Success") onSaved(result.value);
        else setError(formatEnvironmentQueryError(result.cause));
      } else {
        const patch: SharedTaskPatch = Object.fromEntries(
          Object.entries(fields).filter(
            ([key, value]) =>
              JSON.stringify(value) !== JSON.stringify(base[key as keyof typeof fields]),
          ),
        );
        const result = await update({
          environmentId,
          input: {
            taskId: base.id,
            expectedVersion: conflicted
              ? (latest.data?.task.version ?? base.version)
              : base.version,
            patch: {
              ...patch,
              ...(projectId !== (base.projectId ?? "")
                ? { workspaceRoot: project?.workspaceRoot ?? null }
                : {}),
            },
            note: "更新任务目标与跟进信息",
          },
        });
        if (result._tag === "Success") onSaved(result.value);
        else {
          setConflicted(true);
          latest.refresh();
          setError(
            formatEnvironmentQueryError(result.cause) + " 输入已保留；再次保存只提交你改动的字段。",
          );
        }
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{task ? "编辑任务" : "新建任务"}</DialogTitle>
          <DialogDescription>保存一个明确的目标，以及后续会话可以执行的下一步。</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)}>
          <DialogPanel>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor={id + "-title"}>标题</Label>
                <Input
                  id={id + "-title"}
                  value={title}
                  onChange={(event) => setTitle(event.target.value.slice(0, 300))}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={id + "-goal"}>目标</Label>
                <Textarea
                  id={id + "-goal"}
                  value={goal}
                  onChange={(event) => setGoal(event.target.value.slice(0, 8000))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={id + "-next"}>下一步</Label>
                <Textarea
                  id={id + "-next"}
                  value={nextStep}
                  onChange={(event) => setNextStep(event.target.value.slice(0, 8000))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>项目</Label>
                <Select
                  value={projectId || "none"}
                  onValueChange={(value) => setProjectId(value === "none" ? "" : (value ?? ""))}
                >
                  <SelectTrigger aria-label="任务关联项目">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="none">暂不关联项目</SelectItem>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>类型</Label>
                <Select
                  value={kind}
                  onValueChange={(value) => {
                    if (value) setKind(value as SharedTask["kind"]);
                  }}
                >
                  <SelectTrigger aria-label="任务类型">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {Object.entries(kindLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={id + "-tags"}>标签</Label>
                <Input
                  id={id + "-tags"}
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="用逗号分隔"
                />
              </div>
              {base === null ? (
                <div className="space-y-1.5">
                  <Label htmlFor={id + "-steps"}>步骤</Label>
                  <Textarea
                    id={id + "-steps"}
                    value={steps}
                    onChange={(event) => setSteps(event.target.value)}
                    placeholder="每行一个步骤；可以稍后补充"
                  />
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setSteps((current) =>
                          (current.trim() ? current.trimEnd() + "\n" : "") + "规划\n执行\n检验\n测试",
                        )
                      }
                    >
                      插入阶段模板：规划 / 执行 / 检验 / 测试
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    保存后在任务详情里为每个阶段设置模型，「开始此阶段」会用该模型开启会话。
                  </p>
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button type="submit" disabled={!canSave || busy || !title.trim()}>
              {busy ? "正在保存…" : conflicted ? "按最新版本保存修改" : "保存任务"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
