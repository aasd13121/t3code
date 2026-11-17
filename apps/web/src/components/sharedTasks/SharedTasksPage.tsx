import type { EnvironmentId } from "@t3tools/contracts";
import { SharedTasksBoard } from "./SharedTasksBoard";

export function SharedTasksPage(search: { environmentId?: EnvironmentId; taskId?: string }) {
  return <SharedTasksBoard mode="page" {...search} />;
}
