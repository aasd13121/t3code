import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

export interface PanelModuleContext {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
  readonly onClose: () => void;
}

export interface PanelModule {
  readonly id: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly load: () => Promise<{ default: ComponentType<PanelModuleContext> }>;
}
