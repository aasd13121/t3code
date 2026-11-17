import { lazy, Suspense } from "react";
import type { PanelModuleContext } from "../../modules/panelModule";
import { panelModules } from "../../modules/panelModules";
import { Button } from "../ui/button";

const components = Object.fromEntries(
  panelModules.map((module) => [module.id, lazy(module.load)] as const),
);

export function ModulePanel({ moduleId, ...context }: PanelModuleContext & { moduleId: string }) {
  const Component = Object.hasOwn(components, moduleId) ? components[moduleId] : undefined;
  if (!Component)
    return (
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">此面板模块未启用。</p>
        <Button size="sm" variant="outline" onClick={context.onClose}>
          关闭面板
        </Button>
      </div>
    );
  return (
    <Suspense
      fallback={
        <p role="status" className="p-4 text-sm text-muted-foreground">
          正在加载面板…
        </p>
      }
    >
      <Component {...context} />
    </Suspense>
  );
}
