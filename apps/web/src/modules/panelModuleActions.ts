import type { ScopedThreadRef } from "@t3tools/contracts";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { getPanelModule } from "./panelModules";

export function openPanelModule(threadRef: ScopedThreadRef, id: string) {
  const module = getPanelModule(id);
  if (module) useRightPanelStore.getState().openModule(threadRef, module.id, module.title);
}

export function togglePanelModule(threadRef: ScopedThreadRef, id: string) {
  const store = useRightPanelStore.getState();
  const panel = selectThreadRightPanelState(store.byThreadKey, threadRef);
  if (panel.isOpen && panel.activeSurfaceId === `module:${id}`) store.close(threadRef);
  else openPanelModule(threadRef, id);
}
