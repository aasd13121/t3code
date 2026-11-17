import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { SharedTasksBoard } from "../../components/sharedTasks/SharedTasksBoard";
import type { PanelModuleContext } from "../panelModule";

export default function SharedTasksPanel({
  environmentId,
  projectId,
  threadRef,
}: PanelModuleContext) {
  return (
    <SharedTasksBoard
      key={scopedThreadKey(threadRef)}
      mode="panel"
      environmentId={environmentId}
      projectId={projectId}
    />
  );
}
