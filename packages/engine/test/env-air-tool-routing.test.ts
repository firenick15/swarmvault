import { describe, expect, it } from "vitest";
import { classifyEnvAirToolRouting } from "../src/domain/env-air.js";

describe("environment air tool routing", () => {
  it("keeps pure standard and method questions in the knowledge base", () => {
    expect(classifyEnvAirToolRouting("PM2.5 二级年均和24小时平均浓度限值是多少？").finalNextTool).toBe("knowledge_base");
    expect(classifyEnvAirToolRouting("HJ 633 中 AQI 和 IAQI 是怎么计算的？").finalNextTool).toBe("knowledge_base");
    expect(classifyEnvAirToolRouting("HJ 663-2013 和 HJ 663-2026 是什么关系？").finalNextTool).toBe("knowledge_base");
    expect(classifyEnvAirToolRouting("2023 年环境空气质量评价报告依据哪些标准和数据有效性要求？").finalNextTool).toBe("knowledge_base");
  });

  it("requires concrete data signals before asking for the environment data MCP", () => {
    expect(classifyEnvAirToolRouting("分析臭氧生成机理和控制思路").finalNextTool).toBe("knowledge_base");
    expect(classifyEnvAirToolRouting("查询昨天北京国控站 PM2.5 小时值并分析超标过程").finalNextTool).toBe("environment_data_mcp");
    expect(classifyEnvAirToolRouting("按 HJ633 对上周臭氧监测数据计算 AQI").finalNextTool).toBe("both");
  });
});
