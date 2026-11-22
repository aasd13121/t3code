import type { ScopedThreadRef } from "@t3tools/contracts";
import { panelModules } from "../../modules/panelModules";
import { togglePanelModule } from "../../modules/panelModuleActions";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useGT } from "gt-react";

export function PanelModuleControls({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  return panelModules.map((module) => (
    <Tooltip key={module.id}>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          size="sm"
          variant="ghost"
          className="shrink-0 [-webkit-app-region:no-drag]"
          aria-label={gt("Toggle {name}", { name: gt(module.title) })}
          data-panel-module-toggle={module.id}
          pressed={panel.isOpen && panel.activeSurfaceId === `module:${module.id}`}
          onPressedChange={() => togglePanelModule(threadRef, module.id)}
        >
          <module.icon className="size-4" aria-hidden="true" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {gt("Open or close {name}", { name: gt(module.title) })}
      </TooltipPopup>
    </Tooltip>
  ));
}
