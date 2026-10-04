import { create } from "zustand";
import type { InboxItem } from "@monocode/core/wire";
import type { HostConnState, HostRecord } from "./types";

type HostsState = {
  loaded: boolean;
  records: HostRecord[];
  states: Record<string, HostConnState>;
};

export const useHosts = create<HostsState>(() => ({ loaded: false, records: [], states: {} }));

export type AgentRow = InboxItem & { env: string; hostLabel: string };

type AgentsState = {
  items: AgentRow[];
  needsInput: number;
  /** Some machine's rows are from the cache, waiting for the first fetch. */
  cached: boolean;
};

export const useAgents = create<AgentsState>(() => ({ items: [], needsInput: 0, cached: false }));
