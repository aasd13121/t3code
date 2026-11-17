import * as NodeSqlite from "node:sqlite";
import { SharedTaskError, sharedTaskAssigneeProgress } from "@t3tools/contracts";
import type {
  SharedTask,
  SharedTaskCreateInput,
  SharedTaskEvent,
  SharedTaskGetInput,
  SharedTaskGetResult,
  SharedTaskListInput,
  SharedTaskPatch,
  SharedTaskProgressInput,
  SharedTaskSnapshot,
  SharedTaskSource,
  SharedTaskSummary,
  SharedTaskUpdateInput,
} from "@t3tools/contracts";

const summary = (task: SharedTask): SharedTaskSummary => ({
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
  goalExcerpt: task.goal.slice(0, 700),
  nextStepExcerpt: task.nextStep.slice(0, 500),
  blockedReason: task.blockedReason,
  stepCount: task.steps.length,
  completedSteps: task.steps.filter((step) => step.status === "done").length,
  assignees: sharedTaskAssigneeProgress(task.steps),
});

export class SharedTaskStore {
  readonly dbPath: string;
  readonly #db: NodeSqlite.DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.#db = new NodeSqlite.DatabaseSync(this.dbPath);
    this.#db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;",
    );
    const schemaVersion = Number(this.#db.prepare("PRAGMA user_version").get()?.user_version);
    if (schemaVersion > 1) {
      this.#db.close();
      throw new SharedTaskError({ reason: "storage" });
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS shared_tasks (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL,
        project_id TEXT, focused INTEGER NOT NULL, updated_at TEXT NOT NULL,
        data TEXT NOT NULL CHECK (json_valid(data))
      );
      CREATE INDEX IF NOT EXISTS shared_tasks_project_status ON shared_tasks(project_id, status);
      CREATE TABLE IF NOT EXISTS shared_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES shared_tasks(id),
        data TEXT NOT NULL CHECK (json_valid(data))
      );
      CREATE INDEX IF NOT EXISTS shared_task_events_task ON shared_task_events(task_id, id DESC);
      PRAGMA user_version = 1;
    `);
  }

  close() {
    this.#db.close();
  }

  #transaction<A>(body: () => A, write = true): A {
    this.#db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = body();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #read(taskId: string): SharedTask {
    const row = this.#db.prepare("SELECT data FROM shared_tasks WHERE id = ?").get(taskId);
    if (!row) throw new SharedTaskError({ reason: "not-found", taskId });
    return JSON.parse(String(row.data)) as SharedTask;
  }

  #save(task: SharedTask) {
    this.#db
      .prepare(`
      INSERT INTO shared_tasks (id, version, status, project_id, focused, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version, status=excluded.status,
        project_id=excluded.project_id, focused=excluded.focused,
        updated_at=excluded.updated_at, data=excluded.data
    `)
      .run(
        task.id,
        task.version,
        task.status,
        task.projectId,
        Number(task.focused),
        task.updatedAt,
        JSON.stringify(task),
      );
  }

  #record(
    task: SharedTask,
    note: string,
    source: SharedTaskSource,
    changedFields: ReadonlyArray<string>,
  ) {
    this.#db.prepare("INSERT INTO shared_task_events(task_id, data) VALUES (?, ?)").run(
      task.id,
      JSON.stringify({
        taskId: task.id,
        version: task.version,
        createdAt: task.updatedAt,
        note,
        source,
        changedFields,
      }),
    );
  }

  #threads(task: Pick<SharedTask, "threads">, source: SharedTaskSource) {
    if (!source.threadId) return task.threads;
    const thread = {
      threadId: source.threadId,
      ...(source.environmentId ? { environmentId: source.environmentId } : {}),
    };
    return [
      ...task.threads.filter(
        (item) => item.threadId !== thread.threadId || item.environmentId !== thread.environmentId,
      ),
      thread,
    ].slice(-50);
  }

  #validate(task: SharedTask) {
    if (
      !task.title.trim() ||
      new Set(task.steps.map((step) => step.id)).size !== task.steps.length
    ) {
      throw new SharedTaskError({ reason: "invalid-state", taskId: task.id });
    }
    if (task.status === "blocked" && !task.blockedReason?.trim()) {
      throw new SharedTaskError({ reason: "invalid-state", taskId: task.id });
    }
    if (
      task.status === "done" &&
      (task.blockedReason?.trim() || task.steps.some((step) => step.status !== "done"))
    ) {
      throw new SharedTaskError({ reason: "invalid-state", taskId: task.id });
    }
  }

  create(
    input: SharedTaskCreateInput,
    source: SharedTaskSource,
    stamp: { id: string; now: string },
  ): SharedTask {
    return this.#transaction(() => {
      const { id, now } = stamp;
      const task: SharedTask = {
        id,
        version: 1,
        title: input.title.trim(),
        goal: input.goal ?? input.title,
        nextStep: input.nextStep ?? "",
        status: "todo",
        kind: input.kind ?? "feature",
        tags: [...new Set(input.tags ?? [])],
        focused: input.focused ?? false,
        projectId: input.projectId ?? null,
        workspaceRoot: input.workspaceRoot ?? null,
        blockedReason: null,
        steps: input.steps ?? [],
        threads: this.#threads({ threads: [] }, source),
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };
      this.#validate(task);
      this.#save(task);
      this.#record(task, "建立任务", source, ["created"]);
      return task;
    });
  }

  #apply(
    taskId: string,
    expectedVersion: number,
    patch: SharedTaskPatch,
    note: string,
    source: SharedTaskSource,
    now: string,
  ) {
    const before = this.#read(taskId);
    if (before.version !== expectedVersion)
      throw new SharedTaskError({ reason: "conflict", taskId });
    const fields = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const task: SharedTask = {
      ...before,
      ...fields,
      version: before.version + 1,
      updatedAt: now,
      completedAt:
        patch.status === "done"
          ? (before.completedAt ?? now)
          : patch.status !== undefined && patch.status !== "archived"
            ? null
            : before.completedAt,
      threads: this.#threads(before, source),
    };
    this.#validate(task);
    this.#save(task);
    this.#record(task, note, source, Object.keys(fields));
    return task;
  }

  update(input: SharedTaskUpdateInput, source: SharedTaskSource, now: string): SharedTask {
    return this.#transaction(() =>
      this.#apply(input.taskId, input.expectedVersion, input.patch, input.note, source, now),
    );
  }

  progress(input: SharedTaskProgressInput, source: SharedTaskSource, now: string): SharedTask {
    return this.#transaction(() => {
      const before = this.#read(input.taskId);
      const started = new Set(input.startedStepIds ?? []);
      const completed = new Set(input.completedStepIds ?? []);
      if (
        [...started, ...completed].some((id) => !before.steps.some((step) => step.id === id)) ||
        [...started].some(
          (id) =>
            completed.has(id) || before.steps.find((step) => step.id === id)?.status === "done",
        )
      ) {
        throw new SharedTaskError({ reason: "invalid-state", taskId: input.taskId });
      }
      return this.#apply(
        input.taskId,
        input.expectedVersion,
        {
          nextStep: input.nextStep,
          status: input.status ?? (started.size && before.status === "todo" ? "doing" : undefined),
          blockedReason: input.blockedReason,
          ...(completed.size || started.size
            ? {
                steps: before.steps.map((step) =>
                  completed.has(step.id)
                    ? { ...step, status: "done" as const }
                    : started.has(step.id)
                      ? { ...step, status: "doing" as const }
                      : step,
                ),
              }
            : {}),
        },
        input.note,
        source,
        now,
      );
    });
  }

  get(input: SharedTaskGetInput): SharedTaskGetResult {
    return this.#transaction(() => {
      const task = this.#read(input.taskId);
      const limit = Math.min(input.historyLimit ?? 10, 100);
      const rows = this.#db
        .prepare(
          "SELECT id, data FROM shared_task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?",
        )
        .all(task.id, limit + 1);
      return {
        task,
        hasMoreHistory: rows.length > limit,
        events: rows
          .slice(0, limit)
          .map(
            (row) => ({ ...JSON.parse(String(row.data)), id: Number(row.id) }) as SharedTaskEvent,
          ),
      };
    }, false);
  }

  revision(): number {
    return Number(
      this.#db.prepare("SELECT coalesce(max(id), 0) AS n FROM shared_task_events").get()?.n ?? 0,
    );
  }

  list(input: SharedTaskListInput = {}): SharedTaskSnapshot {
    return this.#transaction(() => {
      const clauses: string[] = [];
      const values: NodeSqlite.SQLInputValue[] = [];
      if (!input.includeArchived) clauses.push("status != 'archived'");
      if (input.projectId) {
        clauses.push("project_id = ?");
        values.push(input.projectId);
      }
      if (input.query?.trim()) {
        clauses.push(
          "(instr(lower(json_extract(data, '$.title')), lower(?)) > 0 OR instr(lower(json_extract(data, '$.goal')), lower(?)) > 0)",
        );
        values.push(input.query.trim(), input.query.trim());
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const total = Number(
        this.#db.prepare(`SELECT count(*) AS n FROM shared_tasks ${where}`).get(...values)?.n ?? 0,
      );
      const rows = this.#db
        .prepare(
          `SELECT data FROM shared_tasks ${where} ORDER BY focused DESC, updated_at DESC, id LIMIT ?`,
        )
        .all(...values, Math.min(input.limit ?? 100, 200));
      const revision = this.revision();
      return {
        revision,
        total,
        tasks: rows.map((row) => summary(JSON.parse(String(row.data)) as SharedTask)),
      };
    }, false);
  }
}
