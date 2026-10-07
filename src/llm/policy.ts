// The single gate in front of RADR_AGENT_CMD (PRD §9, T2.6). In M1 the only policy is `off`:
// any attempt to invoke the agent is refused BEFORE a process is spawned. M4 adds the
// metadata-only and code-allowed paths behind this same function.

import { RefusedError } from "../core/errors.js";
import type { EngagementDoc } from "../engagement/config.js";

export interface AgentRequest {
  readonly purpose: string;
  readonly prompt: string;
}

export function invokeAgent(policy: EngagementDoc["llm_policy"], req: AgentRequest): Promise<never> {
  if (policy === "off") {
    return Promise.reject(new RefusedError(`LLM policy is "off" for this engagement; refusing agent call (${req.purpose})`));
  }
  return Promise.reject(new RefusedError(`LLM policy "${policy}" is not implemented until M4 (${req.purpose})`));
}
