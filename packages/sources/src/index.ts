/** @dshsa/sources: GitHub and Feishu/Lark Source kinds for dshsa cells (ported in part from dsh-superagent, MIT). */
export { githubKind, ingestGithub, reconcileRound, wanted, agentOf, type GithubConfig } from './github/kind.ts'
export { webhookIntake, restReview, payloadNumber, GITHUB_EVENTS, type Intake, type GithubEvent } from './github/webhook.ts'
export { SOURCE as GITHUB, githubChannel, githubPage, githubAddress, UserSchema, CommentSchema, IssueSchema, isHumanLogin, reviewPlace,
  mentions, isAgent, commentTrigger, issueTrigger, pullTrigger, branchCiTrigger, ciTrigger, type AgentIdentity, type GithubComment,
  type GithubIssue, type PullRef } from './github/trigger.ts'
export { observePull, claimPull, pullEndNotices, pullsOf, pullOf, agentPull, ticketBranch, readPull, type Pull } from './github/pull.ts'
export { readGithub, readRepositoryPath, pullChecks, ciSummary, githubThreadContext } from './github/read.ts'
export { sendGithub, githubLink } from './github/channel.ts'
export { KV } from './kv.ts'
export { prefersChinese } from './language.ts'
export { POLL_HORIZON_MS, cursorAt, polled, pause } from './poll.ts'
export { feishuKind, ingestFeishu, refreshChatNames, syncBoundChats, chatMembers, FEISHU_EVENT_KINDS, type BoundChat, type FeishuConfig } from './feishu/kind.ts'
export { SOURCE as FEISHU, feishuChannel, feishuThreadId, feishuTriggerId, withMentionNames, feishuTime, feishuTrigger, feishuParent,
  feishuRef, HistoricalMessageSchema, HistoryPageSchema, contentText, historyText, historyEvent, ReceiveEventSchema, sdkEvent,
  historyAsEvent, receiveTrigger, type FeishuEvent, type FeishuRef, type HistoricalMessage, type ReceiveEvent } from './feishu/trigger.ts'
export { feishuRead, readFeishu, feishuResource, feishuReferences, feishuThreadContext, readAdmissionImage, admissionImageKeys, getMessage,
  listMessages, historyView } from './feishu/read.ts'
export { sendFeishu, feishuLink, feishuChatLink, markdownPost } from './feishu/channel.ts'
