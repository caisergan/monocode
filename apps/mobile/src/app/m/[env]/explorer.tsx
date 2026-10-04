import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { useProjects } from "@/sync/projects";
import { useTokens } from "@/ui/theme";
import { HeaderTitle } from "@/ui/toolbar";
import { ExplorerPane } from "@/workspace/ExplorerPane";
import { basename } from "@/workspace/paths";

/** Explorer for one working copy, from a session's ⋯ menu (11 §11.20). */
export default function ExplorerScreen() {
  const { env, projectId, cwd } = useLocalSearchParams<{ env: string; projectId: string; cwd?: string }>();
  const t = useTokens();
  const project = useProjects((store) => store.hosts[env]?.projects.find((item) => item.id === projectId));
  const [path, setPath] = useState("");
  const root = cwd ? basename(cwd) : (project?.name ?? "Project");
  return (
    <View style={{ flex: 1, backgroundColor: t.base }}>
      <Stack.Screen options={{ headerTitle: () => <HeaderTitle title="Explorer" subline={root} /> }} />
      <ExplorerPane env={env} projectId={projectId} cwd={cwd} rootLabel={root} path={path} onPath={setPath} />
    </View>
  );
}
