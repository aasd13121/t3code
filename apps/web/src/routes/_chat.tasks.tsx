import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { SharedTasksPage } from "../components/sharedTasks/SharedTasksPage";

function SharedTasksRoute() {
  return <SharedTasksPage {...Route.useSearch()} />;
}

export const Route = createFileRoute("/_chat/tasks")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: raw.environmentId.trim().slice(0, 200) as EnvironmentId }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: raw.taskId.trim().slice(0, 200) }
      : {}),
  }),
  component: SharedTasksRoute,
});
