import { sessionWorkCwd, type HarnessId } from "./session";
import { listsNativeCommands, type SkillCatalogContext } from "../../skills/model/skills";

type SkillWarmupSession = {
  id?: string;
  harness: HarnessId;
  cwd: string;
  worktreeCwd?: string;
};

export function nativeSkillContextForSession(
  session: SkillWarmupSession,
): SkillCatalogContext | null {
  if (!listsNativeCommands(session.harness)) return null;
  return {
    harness: session.harness,
    cwd: sessionWorkCwd(session),
    ...(session.id ? { sessionId: session.id } : {}),
  };
}
