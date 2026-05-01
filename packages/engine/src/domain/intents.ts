import type { QueryOptions } from "../types.js";
import type { EnvAirQueryPlan } from "./env-air.js";
import { buildEnvAirQueryPlan } from "./env-air.js";
import { DEFAULT_ENV_AIR_PROFILE, type EnvAirProfile } from "./env-air-profile.js";

export function buildDomainQueryPlan(
  query: string,
  profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE,
  options: Partial<QueryOptions> = {}
): EnvAirQueryPlan {
  return buildEnvAirQueryPlan(query, profile, options);
}
