import { ListTodoIcon } from "lucide-react";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";
import type { PanelModule } from "../panelModule";

export const sharedTasksModule = {
  id: "shared-tasks",
  title: m(msg("Task board")),
  icon: ListTodoIcon,
  load: () => import("./SharedTasksPanel"),
} satisfies PanelModule;
