import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  SharedTaskError,
  sharedTaskAssigneeProgress,
  type SharedTask,
  type SharedTaskProgressInput,
  type SharedTaskSnapshot,
  type SharedTaskGetResult,
  type SharedTaskUpdateInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SharedTasksPage } from "./SharedTasksPage";
import { PanelLayoutControls } from "../chat/PanelLayoutControls";
import { ModulePanel } from "../modules/ModulePanel";
import {
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";

const environmentId = EnvironmentId.make("laptop");
const state = vi.hoisted(() => ({
  task: undefined as unknown as SharedTask,
  registry: undefined as unknown as AtomRegistry.AtomRegistry,
  model: undefined as unknown as Atom.Writable<SharedTask>,
  permission: undefined as unknown as Atom.Writable<boolean>,
  snapshot: undefined as unknown as Atom.Atom<AsyncResult.AsyncResult<SharedTaskSnapshot>>,
  detail: undefined as unknown as Atom.Atom<AsyncResult.AsyncResult<SharedTaskGetResult>>,
  progress: vi.fn(),
  update: vi.fn(),
  start: vi.fn(),
  reuseCurrentDraft: false,
}));

function publish(task: SharedTask) {
  state.task = task;
  state.registry.set(state.model, task);
}

function snapshot(task: SharedTask): SharedTaskSnapshot {
  return {
    revision: task.version,
    total: 1,
    tasks: [
      {
        id: task.id,
        version: task.version,
        title: task.title,
        status: task.status,
        kind: task.kind,
        tags: task.tags,
        focused: task.focused,
        projectId: task.projectId,
        workspaceRoot: task.workspaceRoot,
        updatedAt: task.updatedAt,
        threads: task.threads,
        goalExcerpt: task.goal,
        nextStepExcerpt: task.nextStep,
        blockedReason: task.blockedReason,
        stepCount: task.steps.length,
        completedSteps: task.steps.filter((step) => step.status === "done").length,
        assignees: sharedTaskAssigneeProgress(task.steps),
      },
    ],
  };
}

function setup(events: SharedTaskGetResult["events"] = []) {
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  state.task = {
    id: "work-save",
    version: 1,
    title: "持续跟进保存功能",
    goal: "保存后能够恢复记录",
    nextStep: "检查现有实现",
    status: "doing",
    kind: "feature",
    tags: ["保存"],
    focused: false,
    projectId: "project",
    workspaceRoot: "/home/user/app",
    blockedReason: null,
    steps: [{ id: "verify", title: "验证保存行为", status: "todo" }],
    threads: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
  };
  state.registry = AtomRegistry.make();
  state.permission = Atom.make(true);
  state.model = Atom.make(state.task).pipe(Atom.keepAlive);
  state.snapshot = Atom.make((get) => AsyncResult.success(snapshot(get(state.model)))).pipe(
    Atom.keepAlive,
  );
  state.detail = Atom.make((get) =>
    AsyncResult.success({ task: get(state.model), events, hasMoreHistory: false }),
  ).pipe(Atom.keepAlive);
  state.start.mockReset();
  state.reuseCurrentDraft = false;
  state.update
    .mockReset()
    .mockImplementation(async (_registry, request: { input: SharedTaskUpdateInput }) => {
      if (request.input.expectedVersion !== state.task.version)
        return AsyncResult.failure(
          Cause.fail(new SharedTaskError({ reason: "conflict", taskId: state.task.id })),
        );
      const fields = Object.fromEntries(
        Object.entries(request.input.patch).filter(([, value]) => value !== undefined),
      );
      const next = { ...state.task, ...fields, version: state.task.version + 1 };
      publish(next);
      return AsyncResult.success(next);
    });
  state.progress
    .mockReset()
    .mockImplementation(async (_registry, request: { input: SharedTaskProgressInput }) => {
      const input = request.input;
      if (input.expectedVersion !== state.task.version) {
        return AsyncResult.failure(
          Cause.fail(new SharedTaskError({ reason: "conflict", taskId: state.task.id })),
        );
      }
      const next = {
        ...state.task,
        version: state.task.version + 1,
        ...(input.nextStep !== undefined ? { nextStep: input.nextStep } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      };
      publish(next);
      return AsyncResult.success(next);
    });
  return { [Symbol.dispose]: () => state.registry.dispose() };
}

vi.mock("../../state/sharedTasks", () => ({
  sharedTaskEnvironment: {
    subscribe: () => state.snapshot,
    get: () => state.detail,
    create: { label: "test:create", run: vi.fn(), permissionAtom: () => state.permission },
    update: { label: "test:update", run: state.update, permissionAtom: () => state.permission },
    progress: {
      label: "test:progress",
      run: state.progress,
      permissionAtom: () => state.permission,
    },
  },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId, label: "Laptop" }] }),
  usePrimaryEnvironmentId: () => environmentId,
}));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => 0 }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "project", environmentId, title: "App", workspaceRoot: "/home/user/app" },
  ],
  useQuietThreadShells: () => [
    {
      id: "implementation-thread",
      environmentId,
      title: "实现会话",
      projectId: "project",
      archivedAt: null,
    },
    {
      id: "verification-thread",
      environmentId,
      title: "验证会话",
      projectId: "project",
      archivedAt: null,
    },
  ],
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => {
    const navigate = useNavigate();
    return async (...args: unknown[]) => {
      state.start(...args);
      if (!state.reuseCurrentDraft) await navigate({ href: "/draft/task-draft" });
      return { draftId: "task-draft", threadId: "new-thread" };
    };
  },
}));

function Host() {
  const search = useLocation({ select: (location) => location.searchStr });
  const taskId = new URLSearchParams(search).get("taskId");
  return (
    <RegistryContext value={state.registry}>
      <SidebarProvider>
        <SharedTasksPage environmentId={environmentId} {...(taskId ? { taskId } : {})} />
      </SidebarProvider>
    </RegistryContext>
  );
}

function PanelHost() {
  const threadRef = scopeThreadRef(environmentId, ThreadId.make("current-thread"));
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const surface = useRightPanelStore((state) =>
    selectActiveRightPanelSurface(state.byThreadKey, threadRef),
  );
  return (
    <RegistryContext value={state.registry}>
      <SidebarProvider>
        <PanelLayoutControls
          moduleThreadRef={threadRef}
          terminalAvailable={false}
          terminalOpen={false}
          terminalShortcutLabel={null}
          threadPanelOpen={false}
          threadPanelPresentation="inline"
          threadPanelShortcutLabel={null}
          rightPanelAvailable
          rightPanelOpen={panel.isOpen}
          rightPanelShortcutLabel={null}
          onToggleTerminal={() => {}}
          onToggleThreadPanel={() => {}}
          onToggleRightPanel={() => useRightPanelStore.getState().toggleVisibility(threadRef)}
        />
        {panel.isOpen && surface?.kind === "module" ? (
          <ModulePanel
            moduleId={surface.moduleId}
            environmentId={environmentId}
            projectId={ProjectId.make("project")}
            threadRef={threadRef}
            visible
            onClose={() => useRightPanelStore.getState().closeSurface(threadRef, surface.id)}
          />
        ) : null}
      </SidebarProvider>
    </RegistryContext>
  );
}

it("opens the task module from the App's right controls and keeps the conversation when task details close", async () => {
  using _fixture = setup();
  await using screen = await render(<PanelHost />, { router: "/laptop/current-thread" });
  const toggle = page.getByRole("button", { name: "切换任务板", exact: true });
  await toggle.click();
  await expect.element(page.getByRole("region", { name: "共享任务板" })).toBeVisible();
  await page.getByRole("button", { name: "详情与跟进", exact: true }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/laptop/current-thread");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(screen.router?.state.location.pathname).toBe("/laptop/current-thread");
  state.reuseCurrentDraft = true;
  await page.getByRole("button", { name: "详情与跟进", exact: true }).click();
  await page.getByRole("button", { name: "在新会话跟进", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(screen.router?.state.location.pathname).toBe("/laptop/current-thread");
  await expect.element(page.getByRole("region", { name: "共享任务板" })).toBeVisible();
  await toggle.click();
  await expect.element(page.getByRole("region", { name: "共享任务板" })).not.toBeInTheDocument();
});

it("keeps an in-progress note during another session's update and retries only edited fields", async () => {
  using _fixture = setup();
  await using screen = await render(<Host />, { router: "/tasks" });
  await screen.getByRole("button", { name: "详情与跟进" }).click();
  const note = page.getByRole("textbox", { name: "本次进展" });
  const next = page.getByRole("textbox", { name: "下一步", exact: true });
  await userEvent.fill(note, "检查了保存实现，待补充恢复验证");
  await userEvent.fill(next, "我的下一步");
  await act(() =>
    publish({
      ...state.task,
      version: 2,
      goal: "另一个会话补充的目标",
      nextStep: "另一个会话的下一步",
    }),
  );
  await page.getByRole("button", { name: "保存进度", exact: true }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(note).toHaveValue("检查了保存实现，待补充恢复验证");
  await expect.element(next).toHaveValue("我的下一步");
  await page.getByRole("button", { name: "按最新版本保存修改" }).click();
  await vi.waitFor(() => {
    expect(state.task.version).toBe(3);
    expect(state.task.goal).toBe("另一个会话补充的目标");
    expect(state.task.nextStep).toBe("我的下一步");
  });
  expect(state.progress.mock.calls[0]?.[1].input.expectedVersion).toBe(1);
  expect(state.progress.mock.calls[1]?.[1].input.expectedVersion).toBe(2);
});

it("opens a task's prepared conversation without returning to the tasks page", async () => {
  using _fixture = setup();
  await using screen = await render(<Host />, { router: "/tasks?taskId=work-save" });
  await page.getByRole("button", { name: "在新会话跟进" }).click();
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/draft/task-draft"));
  expect(state.start).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "project", environmentId }),
    expect.objectContaining({ prompt: expect.stringContaining("t3_task_get") }),
  );
  expect(state.start.mock.calls[0]?.[1].prompt).toContain("work-save");
});

it("saves an assignee and conversation after a conflict without reverting another agent's completed step", async () => {
  using _fixture = setup([
    {
      id: 1,
      taskId: "work-save",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      note: "原会话检查了保存行为",
      source: { actor: "ai", threadId: "verification-thread", environmentId },
      changedFields: [],
    },
  ]);
  publish({
    ...state.task,
    steps: [
      {
        id: "implement",
        title: "实现保存",
        status: "doing",
        assignee: "实现智能体",
        thread: { environmentId, threadId: "implementation-thread" },
      },
      { id: "verify", title: "验证保存行为", status: "todo", assignee: "验证智能体" },
    ],
  });
  await using screen = await render(<Host />, { router: "/tasks?taskId=work-save" });
  const step = page.getByRole("group", { name: "步骤：验证保存行为" });
  await step.getByRole("button", { name: "设置分工", exact: true }).click();
  const owner = page.getByRole("textbox", { name: "负责人", exact: true });
  await userEvent.fill(owner, "测试智能体");
  await page.getByRole("combobox", { name: "关联智能体会话", exact: true }).click();
  await page.getByRole("option", { name: "验证会话", exact: true }).click();
  await act(() =>
    publish({
      ...state.task,
      version: 2,
      steps: state.task.steps.map((value) =>
        value.id === "implement" ? { ...value, status: "done" } : value,
      ),
    }),
  );
  await page.getByRole("button", { name: "保存分工", exact: true }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(owner).toHaveValue("测试智能体");
  await page.getByRole("button", { name: "按最新版本保存分工", exact: true }).click();
  await vi.waitFor(() => {
    expect(state.task.version).toBe(3);
    expect(state.task.steps[0]).toMatchObject({
      status: "done",
      assignee: "实现智能体",
      thread: { threadId: "implementation-thread" },
    });
    expect(state.task.steps[1]).toMatchObject({
      status: "todo",
      assignee: "测试智能体",
      thread: { threadId: "verification-thread", environmentId },
    });
  });
  await expect
    .element(
      page
        .getByRole("region", { name: "协作进度" })
        .getByText("已完成 1/1 · 进行中 0", { exact: true }),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "任务进度历史" }).getByText(/· AI$/, { exact: true }))
    .toBeVisible();
  await step.getByRole("button", { name: "打开负责人会话", exact: true }).click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/laptop/verification-thread"),
  );
});
