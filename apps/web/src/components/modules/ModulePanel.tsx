import { lazy, Suspense } from "react";
import type { PanelModuleContext } from "../../modules/panelModule";
import { panelModules } from "../../modules/panelModules";
import { Button } from "../ui/button";
import { T } from "gt-react";

const components = Object.fromEntries(
  panelModules.map((module) => [module.id, lazy(module.load)] as const),
);

export function ModulePanel({ moduleId, ...context }: PanelModuleContext & { moduleId: string }) {
  const Component = Object.hasOwn(components, moduleId) ? components[moduleId] : undefined;
  if (!Component)
    return (
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          <T>This panel module is unavailable.</T>
        </p>
        <Button size="sm" variant="outline" onClick={context.onClose}>
          <T>Close panel</T>
        </Button>
      </div>
    );
  return (
    <Suspense
      fallback={
        <p role="status" className="p-4 text-sm text-muted-foreground">
          <T>Loading panel…</T>
        </p>
      }
    >
      <Component {...context} />
    </Suspense>
  );
}
