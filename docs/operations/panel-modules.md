# Adding an App panel module

Desktop shares the web client, so a registered panel module ships in both clients.
This interface supports modules compiled into T3 Code. It does not discover,
install, or sandbox third-party code at runtime. MCP tools and MCP Apps remain
separate extension mechanisms: they provide agent tools and conversation-owned
interfaces, respectively.

Implement a component accepting [PanelModuleContext](../../apps/web/src/modules/panelModule.ts),
export its descriptor, and add that descriptor to
[panelModules](../../apps/web/src/modules/panelModules.ts). Keep the ID stable: it
is used to restore panel tabs and closed views across restarts.

```tsx
// modules/myPanel/module.ts
import { NotebookPen } from "lucide-react";
import type { PanelModule } from "../panelModule";

export const myPanelModule = {
  id: "my-panel",
  title: "Notes",
  icon: NotebookPen,
  load: () => import("./MyPanel"),
} satisfies PanelModule;
```

The host adds the module's toolbar control, tab, and panel menu entries. The
component loads when opened and receives the environment, project, thread,
visibility, and close action. Modules do not need changes to ChatView or the panel
store. See [sharedTasks/module.ts](../../apps/web/src/modules/sharedTasks/module.ts)
for the task board registration.

Use environment-scoped client RPC operations for data access; a panel may belong
to a remote environment. Keep server behavior in a service and expose agent-facing
capabilities through MCP. Removing a registration leaves saved tabs closable
rather than preventing the client from loading.

Build `@t3tools/desktop` to include the module in the packaged Windows client and
server sidecar. Update the client and server in the WSL runtime archive together;
shipping a new toolbar with an older task RPC service leaves the panel unusable.
