import { createSharedTaskEnvironmentAtoms } from "@t3tools/client-runtime/state/sharedTasks";
import { connectionAtomRuntime } from "../connection/runtime";

export const sharedTaskEnvironment = createSharedTaskEnvironmentAtoms(connectionAtomRuntime);
