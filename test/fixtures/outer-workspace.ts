import { writeFileSync } from "node:fs";

// Protocol fixture: records one dispatch, never launches a shell.
import { withOuterWorkspace } from "../../index.ts";
export default withOuterWorkspace({
  identity: "fixture-instance",
  async execute(action, signal) {
    signal.throwIfAborted();
    if (
      action.cwd !== process.cwd() ||
      action.command.join("\0") !==
        ["/bin/bash", "--noprofile", "--norc", "-c", "printf fixture > sentinel"].join("\0")
    )
      throw Error("Wrong action");
    writeFileSync("dispatch-count", "1", { flag: "wx" });
    return { exitCode: 0, output: "fixture dispatch" };
  },
});
