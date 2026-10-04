// The desktop's session model, re-exported in place. Moving these files into
// this package is deferred (see docs/mobile/02-architecture.md "As built"):
// several in-flight desktop branches edit them.
export type {
  Block,
  BlockRole,
  HarnessId,
  RuntimeMode,
  Session,
  ToolPreview,
  ToolPreviewLine,
  AgentStep,
  Attachment,
  TaskListMeta,
  PlanBlockMeta,
  UsageLimit,
} from "../../../src/features/sessions/model/session";
export {
  HARNESS_LABEL,
  RUNTIME_MODES,
  RUNTIME_MODE_LABEL,
  RUNTIME_MODE_HINT,
  hasPendingApproval,
  sessionNeedsInput,
} from "../../../src/features/sessions/model/session";
export type {
  UserQuestion,
  UserQuestionPrompt,
  UserQuestionReply,
} from "../../../src/features/sessions/model/userQuestion";
export {
  REMOTE_PROVIDERS,
  applySessionSync,
  isRemoteProvider,
} from "../../../src/features/connections/model/protocol";
export type {
  CommandReceipt,
  HostCommand,
  HostDescriptor,
  HostModelCatalog,
  HostProject,
  HostSession,
  HostSessionSummary,
  RemoteAttachment,
  RemoteProvider,
  SessionSync,
  SessionSyncResponse,
} from "../../../src/features/connections/model/protocol";
