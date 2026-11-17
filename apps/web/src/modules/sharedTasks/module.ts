import { ListTodoIcon } from "lucide-react";
import type { PanelModule } from "../panelModule";

export const sharedTasksModule = {
  id: "shared-tasks",
  title: "任务板",
  icon: ListTodoIcon,
  load: () => import("./SharedTasksPanel"),
} satisfies PanelModule;
