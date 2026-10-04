import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { useProjects } from "@/sync/projects";
import { useTokens } from "@/ui/theme";
import { HeaderTitle } from "@/ui/toolbar";
import { ChangesPane } from "@/workspace/ChangesPane";
import { basename } from "@/workspace/paths";

/** Changes for one working copy, from a session's ⋯ menu (11 §11.20). */
export default function ChangesScreen() {
  const { env, projectId, cwd } = useLocalSearchParams<{ env: string; projectId: string; cwd?: string }>();
  const t = useTokens();
  const project = useProjects((store) => store.hosts[env]?.projects.find((item) => item.id === projectId));
  return (
    <View style={{ flex: 1, backgroundColor: t.base }}>
      <Stack.Screen options={{ headerTitle: () => <HeaderTitle title={project?.name ?? "Project"} subline={cwd ? basename(cwd) : undefined} /> }} />
      <ChangesPane env={env} projectId={projectId} cwd={cwd} />
    </View>
  );
}
