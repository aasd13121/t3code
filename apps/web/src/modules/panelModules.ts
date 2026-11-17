import type { PanelModule } from "./panelModule";
import { sharedTasksModule } from "./sharedTasks/module";

export const panelModules: ReadonlyArray<PanelModule> = [sharedTasksModule];
export const getPanelModule = (id: string) => panelModules.find((module) => module.id === id);
