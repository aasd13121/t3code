# Open Unreal assets from chat

Click a `.uasset` or `.umap` file link in a conversation to select the asset in
Unreal's Content Browser and open its editor. Project and project-plugin Content
folders are supported. Ordinary source files still use T3 Code's file viewer.

Keep the matching Unreal project open with Epic's built-in **Python Editor
Script Plugin** and **Editor Scripting Utilities** enabled. In **Project Settings > Plugins > Python**, enable
**Remote Execution**. No third-party Unreal plugin, MCP server, or separate Python
installation is needed.

T3 Code discovers the editor through Unreal's own local Python remote-execution
protocol (multicast endpoint `239.0.0.1:6766` by default), and reads a custom
`RemoteExecutionMulticastGroupEndpoint` from the project's engine configuration.
Connections stay on the environment's local machine. A remote conversation opens
the asset on that environment's machine, rather than on the phone or browser's
machine.

Opening a map requires stopping Play in Editor and saving the current level
first. Asset links do not start or rebuild Unreal Engine.
