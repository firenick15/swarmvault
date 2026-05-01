export interface EnvAirStandardCatalogEntry {
  identity: string;
  family: string;
  number: string;
  current?: string;
  title: string;
  aliases: string[];
  clusterIds?: string[];
  documentRoleHints?: string[];
}

export interface EnvAirStandardCluster {
  id: string;
  title: string;
  standards: string[];
  aliases?: string[];
  evidenceRoles?: string[];
  documentRoles?: string[];
}

export interface EnvAirIntentRule {
  id: string;
  priority: number;
  anyText?: string[];
  allText?: string[];
  anyTermGroups?: string[][];
  anyPollutant?: boolean;
  expandedTerms?: string[];
  pinnedStandards?: string[];
  standardClusters?: string[];
  rankingSignals?: string[];
  factTypeBoosts?: Record<string, number>;
  documentRoleBoosts?: Record<string, number>;
  evidenceRoleBoosts?: Record<string, number>;
  chunkTermBoosts?: Record<string, number>;
  routePolicy?: "knowledge" | "data" | "both" | "defer";
}

export interface EnvAirTopicSeed {
  id: string;
  title: string;
  anyText?: string[];
  domainAuthorityLayers?: string[];
}

export interface EnvAirProfile {
  id: string;
  standardCatalog: EnvAirStandardCatalogEntry[];
  standardClusters: EnvAirStandardCluster[];
  envTerms: string[];
  termAliases: Record<string, string[]>;
  pollutantFocusTerms: Record<string, string[]>;
  dataObjectTerms: string[];
  dataTimeTerms: string[];
  dataLocationTerms: string[];
  dataOperationTerms: string[];
  explicitDataToolTerms: string[];
  knowledgeOperationTerms: string[];
  knowledgeHints: string[];
  basisOnlyTerms: string[];
  currentBasisHints: string[];
  limitHints: string[];
  aqiHints: string[];
  monitoringMethodHints: string[];
  authorityBoundaryHints: string[];
  intentRules: EnvAirIntentRule[];
  topicSeeds: EnvAirTopicSeed[];
  shortSlugAllowlist: string[];
  sourceAnalysisSystemPrompt: string[];
  topicSynthesisPromptLines: string[];
}

export const DEFAULT_ENV_AIR_PROFILE: EnvAirProfile = {
  id: "env-air-public",
  standardCatalog: [
    {
      identity: "GB 3095",
      family: "GB",
      number: "3095",
      current: "GB 3095-2026",
      title: "环境空气质量标准",
      aliases: ["GB 3095", "GB3095", "GB 3095-2026", "GB30952026", "环境空气质量标准", "环境空气标准", "空气质量标准"],
      clusterIds: ["ambient_quality_core"]
    },
    {
      identity: "HJ 663",
      family: "HJ",
      number: "663",
      current: "HJ 663-2026",
      title: "环境空气质量评价技术规范",
      aliases: ["HJ 663", "HJ663", "HJ 663-2026", "HJ6632026", "环境空气质量评价技术规范", "达标评价技术规范"],
      clusterIds: ["ambient_quality_core"]
    },
    {
      identity: "HJ 633",
      family: "HJ",
      number: "633",
      current: "HJ 633-2026",
      title: "环境空气质量指数(AQI)技术规定",
      aliases: ["HJ 633", "HJ633", "HJ 633-2026", "HJ6332026", "AQI技术规定", "空气质量指数技术规定", "日报和实时报技术规定"],
      clusterIds: ["ambient_quality_core"]
    },
    {
      identity: "HJ 655",
      family: "HJ",
      number: "655",
      title: "环境空气颗粒物连续自动监测系统安装和验收技术规范",
      aliases: ["HJ 655", "HJ655", "颗粒物连续自动监测系统", "安装和验收技术规范"],
      clusterIds: ["ambient_auto_monitoring_acceptance"]
    },
    {
      identity: "HJ 664",
      family: "HJ",
      number: "664",
      title: "环境空气质量监测点位布设技术规范",
      aliases: ["HJ 664", "HJ664", "监测点位布设", "环境空气质量监测点位"],
      clusterIds: ["ambient_quality_core", "ambient_auto_monitoring_acceptance"]
    },
    {
      identity: "HJ 818",
      family: "HJ",
      number: "818",
      title: "环境空气气态污染物连续自动监测系统运行和质控技术规范",
      aliases: ["HJ 818", "HJ818", "气态污染物连续自动监测系统", "运行和质控技术规范"],
      clusterIds: ["ambient_auto_monitoring_operation_qaqc"]
    }
  ],
  standardClusters: [
    {
      id: "ambient_quality_core",
      title: "环境空气质量评价核心标准族",
      standards: ["GB 3095", "HJ 663", "HJ 633", "HJ 664"],
      aliases: ["环境空气质量标准", "达标评价", "AQI", "空气质量评价"],
      evidenceRoles: ["current_authority", "method"],
      documentRoles: ["standard", "monitoring_method"]
    },
    {
      id: "ambient_auto_monitoring_acceptance",
      title: "环境空气自动监测安装验收标准族",
      standards: ["HJ 655", "HJ 193", "HJ 654"],
      aliases: ["自动监测安装", "验收", "比对测试", "监测系统"],
      evidenceRoles: ["current_authority", "method"],
      documentRoles: ["standard", "monitoring_method", "qa_qc"]
    },
    {
      id: "ambient_auto_monitoring_operation_qaqc",
      title: "环境空气自动监测运行质控标准族",
      standards: ["HJ 818", "HJ 817", "HJ 653", "HJ 654", "HJ 193"],
      aliases: ["运行质控", "质量保证", "质量控制", "有效数据", "负值", "零点", "量程", "转换炉效率", "平行性"],
      evidenceRoles: ["current_authority", "method"],
      documentRoles: ["standard", "monitoring_method", "qa_qc"]
    },
    {
      id: "ambient_manual_sampling_analysis",
      title: "环境空气手工采样与分析方法标准族",
      standards: ["HJ 194", "HJ 618"],
      aliases: ["手工监测", "采样", "样品保存", "测定", "检出限"],
      evidenceRoles: ["method", "current_authority"],
      documentRoles: ["monitoring_method", "standard"]
    },
    {
      id: "ambient_statistics_reporting",
      title: "环境空气统计报告与公报证据族",
      standards: [],
      aliases: ["公报", "月报", "年报", "统计", "城市数量", "评价城市", "统计期"],
      evidenceRoles: ["statistics", "official_explanation"],
      documentRoles: ["statistics", "whitepaper", "official_explanation"]
    },
    {
      id: "ozone_pm25_coordinated_control",
      title: "臭氧与 PM2.5 协同控制证据族",
      standards: ["GB 3095", "HJ 663"],
      aliases: ["臭氧", "PM2.5", "VOCs", "NOx", "协同控制", "来源解析"],
      evidenceRoles: ["current_authority", "method", "research", "statistics"],
      documentRoles: ["standard", "technical_guide", "research_literature", "statistics", "whitepaper"]
    },
    {
      id: "local_adaptation",
      title: "地方适配材料族",
      standards: [],
      aliases: ["地方标准", "地方办法", "地方口径", "省", "市"],
      evidenceRoles: ["local_adaptation"],
      documentRoles: ["standard", "local_reference", "technical_guide"]
    },
    {
      id: "evolution_tracking",
      title: "标准演化材料族",
      standards: [],
      aliases: ["征求意见稿", "编制说明", "修改单", "历史版本", "废止", "替代"],
      evidenceRoles: ["evolution"],
      documentRoles: ["draft", "compilation_explanation", "amendment"]
    }
  ],
  envTerms: [
    "环境空气",
    "空气质量",
    "环境空气质量",
    "自动监测",
    "连续自动监测",
    "监测系统",
    "监测方法",
    "参比方法",
    "手工监测",
    "比对测试",
    "平行性",
    "零点噪声",
    "量程噪声",
    "示值误差",
    "转换炉效率",
    "数据有效性",
    "有效数据",
    "负值数据",
    "负值",
    "质量保证",
    "质量控制",
    "运行维护",
    "运维",
    "标准限值",
    "执行依据",
    "现行标准",
    "强制标准",
    "推荐标准",
    "地方标准",
    "国家标准",
    "技术指南",
    "技术规范",
    "编制说明",
    "征求意见稿",
    "修改单",
    "历史版本",
    "废止",
    "替代",
    "重污染天气",
    "应急减排",
    "绩效分级",
    "达标评价",
    "污染过程",
    "来源解析",
    "协同控制",
    "臭氧",
    "细颗粒物",
    "颗粒物",
    "挥发性有机物",
    "非甲烷总烃",
    "氮氧化物",
    "二氧化硫",
    "二氧化氮",
    "一氧化碳"
  ],
  termAliases: {
    "PM2.5": ["pm2.5", "pm 2.5", "pm25", "细颗粒物"],
    PM10: ["pm10", "pm 10", "可吸入颗粒物"],
    O3: ["o3", "o₃", "臭氧"],
    SO2: ["so2", "so₂", "s o 2", "二氧化硫"],
    NO2: ["no2", "no₂", "n o 2", "二氧化氮"],
    CO: ["co", "一氧化碳"],
    VOCs: ["vocs", "挥发性有机物"],
    NMHC: ["nmhc", "非甲烷总烃"],
    AQI: ["aqi", "空气质量指数"],
    IAQI: ["iaqi", "分指数"]
  },
  pollutantFocusTerms: {
    "PM2.5": ["PM2.5", "PM 2.5", "PM25", "细颗粒物", "年平均", "日平均", "浓度限值", "一级", "二级"],
    PM10: ["PM10", "PM 10", "可吸入颗粒物", "年平均", "日平均", "浓度限值", "一级", "二级"],
    O3: ["O3", "O₃", "臭氧", "日最大8小时平均", "8小时平均", "1小时平均", "浓度限值", "一级", "二级"],
    SO2: ["SO2", "SO₂", "二氧化硫", "年平均", "日平均", "1小时平均", "浓度限值", "一级", "二级"],
    NO2: ["NO2", "NO₂", "二氧化氮", "年平均", "日平均", "1小时平均", "浓度限值", "一级", "二级"],
    CO: ["CO", "一氧化碳", "日平均", "1小时平均", "浓度限值", "一级", "二级"]
  },
  dataObjectTerms: ["监测数据", "实测", "站点数据", "原始数据", "连续监测", "小时值", "日均值", "月均值", "年均值"],
  dataTimeTerms: [
    "今天",
    "今日",
    "昨日",
    "昨天",
    "本周",
    "上周",
    "本月",
    "上月",
    "今年",
    "去年",
    "小时",
    "日均",
    "月均",
    "年均",
    "时段",
    "期间",
    "过程"
  ],
  dataLocationTerms: ["站点", "国控站", "省控站", "城市", "区域", "区县", "省", "市"],
  dataOperationTerms: ["查询", "统计", "排名", "同比", "环比", "趋势", "过程分析", "达标率", "超标天数", "连续负值", "异常诊断"],
  explicitDataToolTerms: ["数据mcp", "环境数据mcp", "监测数据mcp", "调用数据"],
  basisOnlyTerms: ["依据", "标准编号", "适用标准", "采用哪些标准", "评价方法", "计算口径", "技术依据", "报告依据"],
  knowledgeOperationTerms: [
    "标准",
    "规范",
    "指南",
    "依据",
    "限值",
    "浓度限值",
    "评价方法",
    "计算公式",
    "技术规定",
    "适用范围",
    "修订",
    "修改单",
    "关系",
    "口径",
    "编制说明",
    "法律",
    "办法"
  ],
  knowledgeHints: ["知识库", "标准", "规范", "指南", "依据", "限值", "要求", "方法", "解释", "编制说明", "法律", "办法"],
  currentBasisHints: [
    "现行",
    "按什么执行",
    "执行依据",
    "限值",
    "标准",
    "依据",
    "评价报告",
    "报告依据",
    "依据说明",
    "达标评价",
    "评价技术规范",
    "分工",
    "作用",
    "current basis",
    "what standard"
  ],
  limitHints: ["限值", "浓度限值", "一级", "二级", "年平均", "日平均", "小时平均", "日最大", "8小时", "达标", "超标", "评价"],
  aqiHints: ["AQI", "IAQI", "空气质量指数", "日报", "实时报", "日报和实时报", "日报技术规定"],
  monitoringMethodHints: ["监测方法", "采样", "分析方法", "测定", "检出限", "公式", "校准", "质控", "质量控制"],
  authorityBoundaryHints: [
    "研究论文",
    "论文",
    "文献",
    "报告",
    "公报",
    "白皮书",
    "征求意见稿",
    "编制说明",
    "能否作为执法依据",
    "直接执行",
    "要求企业执行",
    "是否强制"
  ],
  intentRules: [
    {
      id: "ambient_air_assessment_validity_question",
      priority: 110,
      anyText: ["数据有效性", "有效数据", "有效性要求", "有效监测数据", "评价数据", "达标评价有效性", "评价有效性"],
      expandedTerms: ["HJ 663", "HJ 663-2026", "环境空气质量评价技术规范", "数据有效性", "有效监测数据", "评价项目和评价方法"],
      pinnedStandards: ["HJ 663", "HJ 663-2026"],
      standardClusters: ["ambient_quality_core", "ambient_auto_monitoring_operation_qaqc"],
      rankingSignals: ["ambient_air_assessment_validity_question"],
      factTypeBoosts: { validity_rule: 5, technical_parameter: 2 },
      chunkTermBoosts: { 数据有效性: 4, 有效数据: 4, 评价项目: 2 }
    },
    {
      id: "ambient_air_quality_limit_question",
      priority: 100,
      anyPollutant: true,
      anyText: ["限值", "浓度限值", "一级", "二级", "年平均", "日平均", "小时平均", "日最大", "8小时", "达标", "超标", "评价"],
      expandedTerms: ["GB 3095", "GB 3095-2026", "GB 3095-2012", "环境空气质量标准", "环境空气质量标准限值", "一级", "二级"],
      pinnedStandards: ["GB 3095", "GB 3095-2026"],
      standardClusters: ["ambient_quality_core"],
      rankingSignals: ["ambient_air_quality_limit_question"],
      factTypeBoosts: { limit_value: 5, formula: 2 },
      evidenceRoleBoosts: { current_authority: 4, method: 2 }
    },
    {
      id: "aqi_reporting_question",
      priority: 90,
      anyText: ["AQI", "IAQI", "空气质量指数", "日报", "实时报", "日报和实时报", "日报技术规定"],
      expandedTerms: ["HJ 633", "HJ 633-2026", "HJ 633-2012", "环境空气质量指数", "空气质量日报", "空气质量实时报"],
      pinnedStandards: ["HJ 633", "HJ 633-2026"],
      standardClusters: ["ambient_quality_core"],
      rankingSignals: ["aqi_reporting_question"],
      factTypeBoosts: { formula: 4, technical_parameter: 2 }
    },
    {
      id: "ambient_air_quality_assessment_question",
      priority: 80,
      anyText: ["评价技术规范", "达标评价", "评价报告", "报告依据", "空气质量评价"],
      expandedTerms: ["HJ 663", "HJ 663-2026", "环境空气质量评价技术规范", "达标评价技术规范"],
      pinnedStandards: ["HJ 663", "HJ 663-2026"],
      standardClusters: ["ambient_quality_core"],
      rankingSignals: ["ambient_air_quality_assessment_question"],
      factTypeBoosts: { validity_rule: 4, formula: 3, limit_value: 2 }
    },
    {
      id: "monitoring_method_question",
      priority: 70,
      anyText: ["监测方法", "采样", "分析方法", "测定", "检出限", "公式", "校准", "质控", "质量控制"],
      expandedTerms: ["环境空气监测方法", "环境空气质量监测规范", "采样", "质量保证", "质量控制"],
      standardClusters: [
        "ambient_auto_monitoring_operation_qaqc",
        "ambient_manual_sampling_analysis",
        "ambient_auto_monitoring_acceptance"
      ],
      rankingSignals: ["monitoring_method_question", "qaqc_question"],
      factTypeBoosts: { technical_parameter: 5, method_step: 4, validity_rule: 3 },
      documentRoleBoosts: { monitoring_method: 4, qa_qc: 4, standard: 2 },
      chunkTermBoosts: { 质控: 4, 质量控制: 4, 校准: 3, 采样: 3 }
    },
    {
      id: "ambient_statistics_reporting_question",
      priority: 65,
      anyText: ["公报", "月报", "年报", "统计", "城市数量", "评价城市", "同比", "环比", "年度报告"],
      expandedTerms: ["环境空气质量公报", "环境空气质量月报", "环境空气质量年报", "统计期", "评价城市", "城市数量"],
      standardClusters: ["ambient_statistics_reporting"],
      rankingSignals: ["ambient_statistics_reporting_question"],
      documentRoleBoosts: { statistics: 5, whitepaper: 2, official_explanation: 2 },
      evidenceRoleBoosts: { statistics: 5, official_explanation: 2 },
      chunkTermBoosts: { 公报: 3, 月报: 3, 年报: 3, 统计: 4, 城市: 2, 评价城市: 4 }
    },
    {
      id: "authority_boundary_question",
      priority: 60,
      anyText: [
        "研究论文",
        "论文",
        "文献",
        "报告",
        "公报",
        "白皮书",
        "征求意见稿",
        "编制说明",
        "能否作为执法依据",
        "直接执行",
        "要求企业执行",
        "是否强制"
      ],
      expandedTerms: ["执行依据", "强制标准", "推荐标准", "征求意见稿", "编制说明", "研究论文", "技术参考", "法律效力"],
      standardClusters: ["evolution_tracking"],
      rankingSignals: ["authority_boundary_question"],
      documentRoleBoosts: { standard: 3, draft: 3, compilation_explanation: 3, research_literature: 2, statistics: 2 }
    },
    {
      id: "amendment_question",
      priority: 50,
      anyText: ["修改单", "甲醛吸收", "副玫瑰苯胺", "修订", "替换"],
      expandedTerms: ["修改单", "结果表示", "按式", "替换"],
      standardClusters: ["evolution_tracking"],
      rankingSignals: ["amendment_question"],
      factTypeBoosts: { status_rule: 4, formula: 3 },
      documentRoleBoosts: { amendment: 5, compilation_explanation: 2 }
    }
  ],
  topicSeeds: [
    {
      id: "ambient-air-quality-limits",
      title: "环境空气质量标准限值",
      anyText: ["GB 3095", "环境空气质量标准", "限值", "浓度限值"]
    },
    {
      id: "aqi-iaqi-method",
      title: "AQI 与 IAQI 评价方法",
      anyText: ["HJ 633", "AQI", "IAQI", "空气质量指数", "日报", "实时报"]
    },
    {
      id: "ambient-air-assessment",
      title: "环境空气质量达标评价",
      anyText: ["HJ 663", "达标评价", "评价技术规范", "环境空气质量评价"]
    },
    {
      id: "monitoring-qaqc",
      title: "环境空气监测方法与质量控制",
      anyText: ["监测方法", "自动监测", "质量控制", "质控", "数据有效性", "点位", "采样", "校准"]
    },
    {
      id: "local-adaptation",
      title: "地方适配与执行口径",
      anyText: ["地方", "省", "市", "DB"],
      domainAuthorityLayers: ["local"]
    },
    {
      id: "standard-evolution",
      title: "标准演化、修改单与历史版本",
      anyText: ["修改单", "征求意见", "编制说明", "历史版本", "废止", "替代", "superseded", "draft"],
      domainAuthorityLayers: ["evolution"]
    }
  ],
  shortSlugAllowlist: ["co", "o3", "so2", "no2", "nox", "pm10", "pm2.5", "pm25", "aqi", "iaqi", "vocs", "nmhc"],
  sourceAnalysisSystemPrompt: [
    "You are compiling a durable markdown wiki and graph for environmental air-pollution knowledge.",
    "Build an integrated expert wiki, not one mechanical concept page per source. Merge related source-backed ideas into durable concepts that help environmental bureau staff decide what can be used in reports, enforcement support, monitoring review, and further research.",
    "Distinguish authority tiers: current mandatory standards and regulations, current monitoring/evaluation methods, recommended technical guides, explanatory or statistical background, research evidence, local implementation rules, draft/evolution materials, amendments, and historical/superseded versions.",
    "Do not treat research papers, monthly reports, annual bulletins, white papers, public interpretations, or technical guides as mandatory execution basis unless the source itself is a binding regulation, current standard, current method standard, or effective local rule.",
    "For each source, preserve retrievable clues for standard codes, pollutants, averaging periods, limit values, formulas, effective dates, implementation dates, replacement relationships, jurisdictions, and document roles.",
    "Prefer concepts around standard limits, evaluation methods, monitoring methods, data QA/QC, abnormal data handling, authority boundaries, local adaptation, historical evolution, and report-writing practice. Avoid generic concepts that only restate broad terms like pollution, environment, monitoring, or standard.",
    "When amendments or drafts appear, identify the affected standard, changed clauses, implementation status, and whether the material is binding or only historical/evolution context."
  ],
  topicSynthesisPromptLines: [
    "你正在为环保局环境空气污染业务构建跨文档专家知识库。",
    "请把多个来源有机综合成一个专业 wiki 页面，而不是逐条复述材料。",
    "必须区分：现行强制执行依据、现行方法规范、推荐性技术指南、统计/报告证据、研究背景、地方口径、征求意见稿/编制说明/历史版本。",
    "报告、研究、白皮书、公报不能直接写成强制执行依据；只有法律、法规、现行标准、现行规范、有效地方规则才能作为执行依据。",
    "输出 Markdown body，使用这些二级标题：专家综合结论、现行执行依据、方法与计算口径、解释统计与研究背景、演化与历史版本、地方适配、不能直接作为依据的材料、来源索引。",
    "所有关键陈述必须带 [source:<source_id>] 引用。"
  ]
};
