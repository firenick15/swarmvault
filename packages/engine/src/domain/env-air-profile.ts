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
      aliases: [
        "GB 3095",
        "GB3095",
        "GB 3095-2026",
        "GB30952026",
        "环境空气质量标准",
        "环境空气标准",
        "空气质量标准",
        "空气质量标准限值表",
        "环境空气质量标准限值",
        "标准污染物项目",
        "污染物项目清单",
        "污染物基本项目",
        "浓度限值表",
        "平均时间"
      ],
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
      aliases: [
        "HJ 633",
        "HJ633",
        "HJ 633-2026",
        "HJ6332026",
        "AQI技术规定",
        "空气质量指数技术规定",
        "日报和实时报技术规定",
        "实时空气质量播报",
        "指数规则",
        "AQI评价项目",
        "IAQI评价项目",
        "空气质量级别",
        "首要污染物",
        "日报评价项目",
        "实时报评价项目"
      ],
      clusterIds: ["ambient_quality_core"]
    },
    {
      identity: "HJ 655",
      family: "HJ",
      number: "655",
      title: "环境空气颗粒物连续自动监测系统安装和验收技术规范",
      aliases: [
        "HJ 655",
        "HJ655",
        "颗粒物连续自动监测系统",
        "颗粒物安装验收",
        "颗粒物自动监测系统验收",
        "自动站安装验收",
        "安装和验收技术规范",
        "站房验收",
        "联网验收",
        "试运行验收"
      ],
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
      aliases: [
        "HJ 818",
        "HJ818",
        "气态污染物连续自动监测系统",
        "运行和质控技术规范",
        "气态污染物运行质控",
        "气态污染物连续自动监测系统运行质控",
        "环境空气气态污染物连续自动监测系统运行质控",
        "自动站运行质控",
        "转换炉效率"
      ],
      clusterIds: ["ambient_auto_monitoring_operation_qaqc"]
    },
    {
      identity: "HJ 817",
      family: "HJ",
      number: "817",
      title: "环境空气颗粒物连续自动监测系统运行和质控技术规范",
      aliases: [
        "HJ 817",
        "HJ817",
        "颗粒物连续自动监测系统运行质控",
        "颗粒物自动站运行质控",
        "颗粒物日常质控",
        "PM10和PM2.5运行质控",
        "颗粒物负值",
        "颗粒物数据质控",
        "环境参数检查"
      ],
      clusterIds: ["ambient_auto_monitoring_operation_qaqc"]
    },
    {
      identity: "HJ 618",
      family: "HJ",
      number: "618",
      title: "环境空气 PM10 和 PM2.5 的测定 重量法",
      aliases: [
        "HJ 618",
        "HJ618",
        "HJ 618-2011",
        "HJ6182011",
        "PM10和PM2.5重量法",
        "PM10 PM2.5重量法",
        "颗粒物重量法",
        "重量法参比方法",
        "参比方法",
        "手工采样重量法",
        "滤膜称量",
        "样品处理",
        "称量质控",
        "恒温恒湿称量",
        "颗粒物参比方法"
      ],
      clusterIds: ["ambient_manual_sampling_analysis"]
    },
    {
      identity: "HJ 653",
      family: "HJ",
      number: "653",
      title: "环境空气颗粒物连续自动监测系统技术要求及检测方法",
      aliases: [
        "HJ 653",
        "HJ653",
        "颗粒物自动监测技术要求",
        "颗粒物自动监测仪性能指标",
        "颗粒物自动监测仪采购检测",
        "PM10和PM2.5自动监测技术要求",
        "PM2.5自动监测仪采购检测",
        "颗粒物检测方法",
        "切割器性能指标",
        "PM10和PM2.5性能测试项目",
        "PM10和PM2.5检测项目",
        "颗粒物自动监测系统检测项目"
      ],
      clusterIds: ["ambient_auto_monitoring_operation_qaqc"]
    },
    {
      identity: "HJ 654",
      family: "HJ",
      number: "654",
      title: "环境空气气态污染物连续自动监测系统技术要求及检测方法",
      aliases: [
        "HJ 654",
        "HJ654",
        "气态自动监测技术要求",
        "气态污染物检测方法",
        "气态仪器采购检测",
        "气态仪器采购验收",
        "设备采购验收",
        "仪器采购验收",
        "SO2 NO2 O3 CO自动监测技术要求",
        "气态仪器性能指标",
        "NO2-NO转换器转换效率"
      ],
      clusterIds: ["ambient_auto_monitoring_acceptance", "ambient_auto_monitoring_operation_qaqc"]
    },
    {
      identity: "HJ 1043",
      family: "HJ",
      number: "1043",
      title: "环境空气 氮氧化物的自动测定 化学发光法",
      aliases: [
        "HJ 1043",
        "HJ1043",
        "HJ 1043-2019",
        "HJ10432019",
        "环境空气氮氧化物自动测定",
        "氮氧化物自动测定",
        "NOx自动测定",
        "NO NO2 NOx自动测定",
        "化学发光法",
        "氮氧化物化学发光法",
        "NOx化学发光法",
        "NO2自动测定方法"
      ],
      clusterIds: ["ambient_gas_measurement_methods"]
    },
    {
      identity: "HJ 193",
      family: "HJ",
      number: "193",
      title: "环境空气气态污染物连续自动监测系统安装验收技术规范",
      aliases: [
        "HJ 193",
        "HJ193",
        "气态自动监测安装验收",
        "气态仪器安装验收",
        "气态自动站安装验收",
        "自动站安装验收规范",
        "气态监测系统调试检测",
        "SO2 NO2 O3 CO安装验收",
        "安装验收调试检测项目"
      ],
      clusterIds: ["ambient_auto_monitoring_acceptance"]
    },
    {
      identity: "HJ 194",
      family: "HJ",
      number: "194",
      title: "环境空气质量手工监测技术规范",
      aliases: ["HJ 194", "HJ194", "环境空气手工监测", "手工采样", "样品保存", "手工监测质控"],
      clusterIds: ["ambient_manual_sampling_analysis"]
    },
    {
      identity: "HJ 75",
      family: "HJ",
      number: "75",
      title: "固定污染源烟气排放连续监测技术规范",
      aliases: [
        "HJ 75",
        "HJ75",
        "固定污染源CEMS运行",
        "固定源CEMS运行",
        "固定污染源烟气CEMS运行维护",
        "固定源CEMS校准维护",
        "固定源CEMS无效数据审核",
        "CEMS运行质控",
        "烟气在线运行维护",
        "CEMS校准维护",
        "CEMS无效数据审核",
        "固定源CEMS运行维护"
      ],
      clusterIds: ["fixed_source_cems"]
    },
    {
      identity: "HJ 76",
      family: "HJ",
      number: "76",
      title: "固定污染源烟气排放连续监测系统技术要求及检测方法",
      aliases: [
        "HJ 76",
        "HJ76",
        "固定污染源CEMS技术要求",
        "固定源CEMS技术要求",
        "烟气CEMS技术要求",
        "CEMS检测方法",
        "CEMS仪器检测方法",
        "固定污染源烟气自动监测技术要求"
      ],
      clusterIds: ["fixed_source_cems"]
    },
    {
      identity: "HJ 212",
      family: "HJ",
      number: "212",
      title: "污染物在线监控（监测）系统数据传输标准",
      aliases: ["HJ 212", "HJ212", "污染物在线监控数据传输", "CEMS数据传输", "在线监测数据传输", "数采仪传输协议"],
      clusterIds: ["fixed_source_cems"]
    },
    {
      identity: "环境保护部令第19号",
      family: "MEE_ORDER",
      number: "19",
      title: "污染源自动监控设施现场监督检查办法",
      aliases: [
        "19号令",
        "环保部19号令",
        "环境保护部令第19号",
        "污染源自动监控设施现场监督检查办法",
        "现场检查办法",
        "污染源自动监控现场检查",
        "自动监控现场检查办法",
        "自动监控设施现场检查",
        "固定源自动监控设施现场检查",
        "现场检查程序",
        "现场检查事项"
      ],
      clusterIds: ["pollution_source_auto_monitoring_enforcement"]
    },
    {
      identity: "国家环保总局令第28号",
      family: "SEPA_ORDER",
      number: "28",
      title: "污染源自动监控管理办法",
      aliases: [
        "28号令",
        "总局令28号",
        "国家环保总局令第28号",
        "污染源自动监控管理办法",
        "自动监控管理",
        "自动监控管理办法",
        "自动监控设施管理",
        "污染源自动监控管理职责",
        "自动监控管理职责",
        "运行维护责任"
      ],
      clusterIds: ["pollution_source_auto_monitoring_enforcement"]
    }
  ],
  standardClusters: [
    {
      id: "ambient_quality_core",
      title: "环境空气质量评价核心标准族",
      standards: ["GB 3095", "HJ 663", "HJ 633", "HJ 664"],
      aliases: [
        "环境空气质量标准",
        "环境空气质量标准限值",
        "标准污染物项目",
        "污染物项目清单",
        "平均时间",
        "达标评价",
        "AQI",
        "IAQI",
        "首要污染物",
        "空气质量级别",
        "空气质量评价"
      ],
      evidenceRoles: ["current_authority", "method"],
      documentRoles: ["standard", "monitoring_method"]
    },
    {
      id: "ambient_auto_monitoring_acceptance",
      title: "环境空气自动监测安装验收标准族",
      standards: ["HJ 655", "HJ 193", "HJ 654"],
      aliases: [
        "自动监测安装",
        "新建自动站验收",
        "新建颗粒物自动监测系统验收",
        "颗粒物安装验收",
        "验收检查清单",
        "验收",
        "比对测试",
        "监测系统",
        "站房",
        "联网验收",
        "试运行"
      ],
      evidenceRoles: ["current_authority", "method"],
      documentRoles: ["standard", "monitoring_method", "qa_qc"]
    },
    {
      id: "ambient_auto_monitoring_operation_qaqc",
      title: "环境空气自动监测运行质控标准族",
      standards: ["HJ 818", "HJ 817", "HJ 653", "HJ 654", "HJ 193"],
      aliases: [
        "运行质控",
        "质量保证",
        "质量控制",
        "有效数据",
        "负值",
        "零点",
        "量程",
        "转换炉效率",
        "气态污染物连续自动监测系统运行质控",
        "环境空气气态污染物连续自动监测系统运行质控",
        "转换效率",
        "转换器效率",
        "转换炉",
        "NO2转换炉",
        "NO2转换效率",
        "二氧化氮转换效率",
        "二氧化氮转换炉",
        "臭氧自动监测运行质控",
        "O3自动监测运行质控",
        "臭氧零跨",
        "O3零跨",
        "零跨检查时段",
        "环境参数检查",
        "温度气压湿度",
        "化学发光法",
        "平行性"
      ],
      evidenceRoles: ["current_authority", "method"],
      documentRoles: ["standard", "monitoring_method", "qa_qc"]
    },
    {
      id: "ambient_manual_sampling_analysis",
      title: "环境空气手工采样与分析方法标准族",
      standards: ["HJ 194", "HJ 618"],
      aliases: [
        "手工监测",
        "采样",
        "样品保存",
        "测定",
        "检出限",
        "参比方法",
        "重量法",
        "手工重量法",
        "滤膜称量",
        "样品处理",
        "称量质控",
        "恒温恒湿"
      ],
      evidenceRoles: ["method", "current_authority"],
      documentRoles: ["monitoring_method", "standard"]
    },
    {
      id: "ambient_gas_measurement_methods",
      title: "环境空气气态污染物自动测定方法标准族",
      standards: ["HJ 1043", "HJ 1044", "HJ 965", "HJ 590"],
      aliases: ["自动测定", "测定方法", "化学发光法", "紫外荧光法", "紫外光度法", "非分散红外法", "NOx", "NO2", "SO2", "O3", "CO"],
      evidenceRoles: ["method", "current_authority"],
      documentRoles: ["monitoring_method", "standard"]
    },
    {
      id: "fixed_source_cems",
      title: "固定污染源自动监测与 CEMS 标准族",
      standards: ["HJ 75", "HJ 76", "HJ 212"],
      aliases: [
        "固定污染源",
        "固定源",
        "固定源CEMS",
        "固定污染源CEMS",
        "烟气",
        "CEMS",
        "在线监测",
        "在线监控",
        "数据传输",
        "数采仪",
        "运行维护",
        "技术要求",
        "校准维护",
        "无效数据审核",
        "数据审核"
      ],
      evidenceRoles: ["current_authority", "method"],
      documentRoles: ["standard", "monitoring_method", "technical_regulation", "regulation"]
    },
    {
      id: "pollution_source_auto_monitoring_enforcement",
      title: "污染源自动监控监管法规族",
      standards: ["环境保护部令第19号", "国家环保总局令第28号"],
      aliases: [
        "污染源自动监控",
        "自动监控设施",
        "在线设备",
        "排污单位",
        "运维单位",
        "现场监督检查",
        "现场检查程序",
        "执法现场",
        "现场检查清单",
        "管理职责",
        "职责主体",
        "职责分工",
        "停运",
        "拆除",
        "故障报告",
        "备案登记",
        "19号令",
        "28号令"
      ],
      evidenceRoles: ["current_authority", "method"],
      documentRoles: ["regulation", "law", "technical_regulation"]
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
      id: "heavy_pollution_weather_policy",
      title: "重污染天气应急与绩效分级材料族",
      standards: [],
      aliases: [
        "重污染天气",
        "污染过程",
        "应急预警",
        "应急响应",
        "应急减排",
        "绩效分级",
        "秋冬季攻坚",
        "黄色预警",
        "橙色预警",
        "红色预警",
        "重污染天气应急材料",
        "重污染天气绩效分级",
        "应急减排清单"
      ],
      evidenceRoles: ["current_authority", "method", "official_explanation"],
      documentRoles: ["policy", "technical_guide", "regulation", "official_explanation"]
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
    "转换效率",
    "转换器效率",
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
  dataObjectTerms: [
    "监测数据",
    "实测",
    "站点数据",
    "原始数据",
    "连续监测",
    "小时值",
    "日均值",
    "月均值",
    "年均值",
    "百分位",
    "第90百分位",
    "第 90 百分位",
    "MDA8"
  ],
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
  dataOperationTerms: [
    "查询",
    "统计",
    "排名",
    "同比",
    "环比",
    "趋势",
    "过程分析",
    "达标率",
    "超标天数",
    "连续负值",
    "异常诊断",
    "计算",
    "第90百分位",
    "第 90 百分位",
    "百分位"
  ],
  explicitDataToolTerms: ["数据mcp", "环境数据mcp", "监测数据mcp", "调用数据"],
  basisOnlyTerms: [
    "依据",
    "标准编号",
    "适用标准",
    "采用哪些标准",
    "评价方法",
    "计算口径",
    "技术依据",
    "报告依据",
    "能否作为",
    "能不能作为",
    "是否可以作为",
    "能否直接",
    "能不能直接",
    "能否替代",
    "是否替代",
    "是否属于",
    "边界",
    "区别"
  ],
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
    "能否作为",
    "能不能作为",
    "是否可以作为",
    "能否直接",
    "能否替代",
    "是否替代",
    "是否属于",
    "边界",
    "区别",
    "征求意见稿",
    "编制说明",
    "能否作为执法依据",
    "直接执行",
    "要求企业执行",
    "是否强制"
  ],
  intentRules: [
    {
      id: "list_complete_question",
      priority: 130,
      anyText: [
        "包括哪些",
        "有哪些",
        "完整清单",
        "全部项目",
        "所有项目",
        "测试项目",
        "检测项目",
        "检查项目",
        "验收项目",
        "质控项目",
        "质量控制项目",
        "性能指标",
        "评价指标",
        "监测项目",
        "清单",
        "要点",
        "步骤"
      ],
      expandedTerms: [
        "表 1",
        "表 2",
        "表 3",
        "检测项目",
        "测试项目",
        "性能指标",
        "指标要求",
        "验收项目",
        "质控项目",
        "检查项目",
        "评价指标",
        "监测项目",
        "完整清单",
        "项目名称",
        "技术要求",
        "检测方法"
      ],
      rankingSignals: ["list_complete_question"],
      factTypeBoosts: { technical_parameter: 7, method_step: 5, validity_rule: 4, formula: 3, limit_value: 2 },
      documentRoleBoosts: { standard: 4, monitoring_method: 5, qa_qc: 5, regulation: 3, technical_guide: 2, statistics: 1 },
      evidenceRoleBoosts: { method: 5, current_authority: 4, statistics: 1 },
      chunkTermBoosts: {
        检测项目: 7,
        测试项目: 7,
        性能指标: 7,
        指标要求: 6,
        验收项目: 6,
        质控项目: 6,
        检查项目: 6,
        评价指标: 5,
        监测项目: 5,
        完整清单: 5,
        表3: 4,
        表2: 3,
        表1: 3
      }
    },
    {
      id: "ambient_quality_standard_list_question",
      priority: 128,
      anyText: ["空气质量标准", "环境空气质量标准", "标准限值表", "标准污染物项目", "污染物项目清单", "平均时间", "基本项目"],
      anyTermGroups: [
        ["空气质量标准", "限值表"],
        ["标准限值表", "平均时间"],
        ["标准污染物项目", "清单"],
        ["污染物项目", "平均时间"],
        ["达标说明", "污染物项目"],
        ["PM2.5", "O3", "NO2", "平均时间"]
      ],
      expandedTerms: [
        "GB 3095",
        "GB 3095-2026",
        "GB3095",
        "环境空气质量标准",
        "环境空气质量标准限值",
        "污染物基本项目",
        "污染物项目",
        "平均时间",
        "浓度限值表"
      ],
      pinnedStandards: ["GB 3095", "GB 3095-2026"],
      standardClusters: ["ambient_quality_core"],
      rankingSignals: ["ambient_air_quality_limit_question", "ambient_quality_standard_list_question"],
      factTypeBoosts: { limit_value: 7, technical_parameter: 4, validity_rule: 2 },
      documentRoleBoosts: { standard: 7, monitoring_method: 2, statistics: 1 },
      evidenceRoleBoosts: { current_authority: 6, method: 2, statistics: 1 },
      chunkTermBoosts: { 环境空气质量标准: 6, 浓度限值: 7, 平均时间: 6, 污染物项目: 6, 基本项目: 5, 表1: 5, 限值表: 6 }
    },
    {
      id: "ambient_aqi_list_question",
      priority: 127,
      anyText: ["AQI", "IAQI", "空气质量指数", "首要污染物", "空气质量级别", "评价项目"],
      anyTermGroups: [
        ["AQI", "评价项目"],
        ["AQI", "首要污染物"],
        ["IAQI", "评价项目"],
        ["空气质量指数", "评价项目"],
        ["空气质量指数", "首要污染物"],
        ["空气质量级别", "污染物"]
      ],
      expandedTerms: [
        "HJ 633",
        "HJ 633-2026",
        "HJ633",
        "环境空气质量指数",
        "空气质量指数技术规定",
        "IAQI",
        "首要污染物",
        "空气质量级别",
        "评价项目"
      ],
      pinnedStandards: ["HJ 633", "HJ 633-2026"],
      standardClusters: ["ambient_quality_core"],
      rankingSignals: ["aqi_reporting_question", "ambient_aqi_list_question"],
      factTypeBoosts: { formula: 5, technical_parameter: 4, limit_value: 2 },
      documentRoleBoosts: { standard: 6, monitoring_method: 3, statistics: 1 },
      evidenceRoleBoosts: { method: 5, current_authority: 4, statistics: 1 },
      chunkTermBoosts: { AQI: 7, IAQI: 7, 首要污染物: 6, 空气质量级别: 6, 评价项目: 6, 日报: 3, 实时报: 3 }
    },
    {
      id: "ambient_pm_acceptance_list_question",
      priority: 126,
      anyText: ["颗粒物", "PM10", "PM2.5", "新建", "新站", "安装验收", "验收", "验收检查清单", "现场验收", "系统性能"],
      anyTermGroups: [
        ["颗粒物", "验收", "检查清单"],
        ["颗粒物", "自动监测系统", "验收"],
        ["新建", "颗粒物", "验收"],
        ["新站", "颗粒物", "验收"],
        ["颗粒物", "新站", "验收"],
        ["系统性能", "现场验收"],
        ["新建", "自动监测系统", "验收"],
        ["PM10", "PM2.5", "验收"]
      ],
      expandedTerms: [
        "HJ 655",
        "HJ 655-2013",
        "HJ655",
        "环境空气颗粒物连续自动监测系统安装和验收技术规范",
        "颗粒物自动监测系统验收",
        "新建颗粒物自动监测系统验收",
        "颗粒物自动监测新站验收",
        "颗粒物新站安装验收",
        "系统性能和现场验收",
        "验收检查清单",
        "站房",
        "联网验收",
        "试运行"
      ],
      pinnedStandards: ["HJ 655", "HJ 655-2013"],
      standardClusters: ["ambient_auto_monitoring_acceptance"],
      rankingSignals: ["ambient_pm_acceptance_list_question", "ambient_auto_monitoring_qaqc_family_question"],
      factTypeBoosts: { technical_parameter: 6, method_step: 5, validity_rule: 4 },
      documentRoleBoosts: { standard: 6, monitoring_method: 4, qa_qc: 2 },
      evidenceRoleBoosts: { method: 5, current_authority: 3 },
      chunkTermBoosts: { 安装验收: 7, 验收: 6, 检查清单: 6, 站房: 4, 联网: 4, 试运行: 4, 颗粒物: 4 }
    },
    {
      id: "ambient_particulate_reference_method_question",
      priority: 126,
      anyText: ["参比方法", "重量法", "滤膜", "称量", "样品处理", "手工采样", "手工比对"],
      anyTermGroups: [
        ["PM10", "重量法"],
        ["PM2.5", "重量法"],
        ["颗粒物", "重量法"],
        ["参比方法", "重量法"],
        ["参比方法", "PM10"],
        ["参比方法", "PM2.5"],
        ["滤膜", "称量"],
        ["样品处理", "称量"],
        ["手工", "比对"]
      ],
      expandedTerms: [
        "HJ 618",
        "HJ 618-2011",
        "HJ618",
        "环境空气 PM10 和 PM2.5 的测定 重量法",
        "PM10和PM2.5重量法",
        "重量法参比方法",
        "手工采样重量法",
        "滤膜称量",
        "样品处理",
        "称量质控"
      ],
      pinnedStandards: ["HJ 618", "HJ 618-2011"],
      standardClusters: ["ambient_manual_sampling_analysis"],
      rankingSignals: ["ambient_particulate_reference_method_question", "monitoring_method_question"],
      factTypeBoosts: { method_step: 7, technical_parameter: 4, validity_rule: 3 },
      documentRoleBoosts: { monitoring_method: 6, standard: 4, qa_qc: 2 },
      evidenceRoleBoosts: { method: 6, current_authority: 3 },
      chunkTermBoosts: { 参比方法: 7, 重量法: 7, 滤膜: 6, 称量: 6, 样品处理: 5, 恒温恒湿: 5, 质控: 4 }
    },
    {
      id: "heavy_pollution_weather_policy_question",
      priority: 124,
      anyText: ["重污染天气", "重污染过程", "应急预警", "应急响应", "应急减排", "绩效分级", "秋冬季攻坚", "污染过程", "预警材料"],
      anyTermGroups: [
        ["重污染天气", "应急"],
        ["重污染过程", "预警"],
        ["污染过程", "预警"],
        ["污染过程", "应急"],
        ["重污染天气", "材料"],
        ["重污染天气", "绩效分级"],
        ["重污染天气", "检查要点"],
        ["应急减排", "清单"],
        ["应急预警", "减排"],
        ["绩效分级", "检查"]
      ],
      expandedTerms: [
        "重污染天气",
        "重污染天气应急",
        "重污染天气应急预警",
        "重污染天气应急减排",
        "重污染天气重点行业应急减排措施制定技术指南",
        "重污染过程预警材料",
        "重污染天气预警材料",
        "绩效分级",
        "应急减排清单",
        "黄色预警",
        "橙色预警",
        "红色预警"
      ],
      standardClusters: ["heavy_pollution_weather_policy"],
      rankingSignals: ["heavy_pollution_weather_policy_question"],
      factTypeBoosts: { method_step: 5, technical_parameter: 4, status_rule: 3 },
      documentRoleBoosts: { policy: 6, technical_guide: 5, regulation: 4, official_explanation: 3, research_literature: 1, statistics: 1 },
      evidenceRoleBoosts: { current_authority: 5, method: 4, official_explanation: 3, research: 1, statistics: 1 },
      chunkTermBoosts: { 重污染天气: 7, 应急预警: 6, 应急响应: 6, 应急减排: 6, 绩效分级: 6, 检查要点: 5, 应急材料: 5 }
    },
    {
      id: "no2_converter_efficiency_qaqc_question",
      priority: 125,
      anyText: ["转换炉", "转换效率", "转化效率", "转换器效率", "NO2-NO", "NO₂-NO"],
      anyTermGroups: [
        ["NO2", "转换"],
        ["NO₂", "转换"],
        ["二氧化氮", "转换"],
        ["化学发光", "转换"],
        ["气态污染物", "转换炉"],
        ["气态污染物", "转换效率"],
        ["运行质控", "转换炉"],
        ["自动站", "转换炉"],
        ["监测仪", "转换炉"]
      ],
      expandedTerms: [
        "HJ 818",
        "HJ 818-2018",
        "HJ818",
        "环境空气气态污染物连续自动监测系统运行和质控技术规范",
        "气态污染物运行质控",
        "NO2转换炉",
        "二氧化氮转换炉",
        "NO2转换效率",
        "转换炉效率检查",
        "化学发光法NO2监测仪",
        "HJ 654",
        "HJ 654-2013"
      ],
      pinnedStandards: ["HJ 818", "HJ 818-2018"],
      standardClusters: ["ambient_auto_monitoring_operation_qaqc", "ambient_auto_monitoring_acceptance"],
      rankingSignals: ["no2_converter_efficiency_qaqc_question", "qaqc_question", "monitoring_method_question"],
      factTypeBoosts: { limit_value: 7, technical_parameter: 6, method_step: 4, formula: 3 },
      documentRoleBoosts: { qa_qc: 6, monitoring_method: 4, standard: 2 },
      evidenceRoleBoosts: { method: 5, current_authority: 3 },
      chunkTermBoosts: { 转换炉: 7, 转换效率: 7, 转化效率: 7, 每半年: 6, "96%": 5, 化学发光法: 3 }
    },
    {
      id: "ambient_gas_measurement_method_question",
      priority: 116,
      anyText: ["自动测定", "测定方法", "化学发光法", "氮氧化物", "NOx", "NO", "NO2", "方法标准"],
      anyTermGroups: [
        ["氮氧化物", "自动测定"],
        ["氮氧化物", "化学发光法"],
        ["NOx", "自动测定"],
        ["NOx", "化学发光法"],
        ["NO", "NO2", "NOx"],
        ["测定方法", "运行质控"],
        ["方法标准", "运行质控"]
      ],
      expandedTerms: [
        "HJ 1043",
        "HJ 1043-2019",
        "HJ1043",
        "环境空气 氮氧化物的自动测定 化学发光法",
        "氮氧化物自动测定",
        "NOx自动测定",
        "化学发光法测定方法"
      ],
      pinnedStandards: ["HJ 1043", "HJ 1043-2019"],
      standardClusters: ["ambient_gas_measurement_methods", "ambient_auto_monitoring_operation_qaqc"],
      rankingSignals: ["ambient_gas_measurement_method_question", "monitoring_method_question"],
      factTypeBoosts: { technical_parameter: 5, method_step: 5, formula: 3 },
      documentRoleBoosts: { monitoring_method: 6, qa_qc: 2, standard: 2 },
      evidenceRoleBoosts: { method: 5, current_authority: 3 },
      chunkTermBoosts: { 氮氧化物: 6, 自动测定: 6, 化学发光法: 6, NOx: 5, 测定方法: 5 }
    },
    {
      id: "ambient_pm_operation_qaqc_question",
      priority: 108,
      anyText: ["颗粒物", "PM10", "PM2.5", "PM 10", "PM 2.5", "流量审核", "平行性", "负值", "日常质控", "数据一致性", "更换仪器"],
      anyTermGroups: [
        ["颗粒物", "负值"],
        ["颗粒物", "运行质控"],
        ["颗粒物", "数据质控"],
        ["颗粒物", "环境参数"],
        ["环境参数", "质控"],
        ["颗粒物", "平行性"],
        ["颗粒物", "流量审核"],
        ["PM2.5", "负值"],
        ["PM10", "负值"],
        ["PM2.5", "平行性"],
        ["PM10", "平行性"],
        ["PM2.5", "流量"],
        ["PM10", "流量"],
        ["更换", "颗粒物", "仪器"],
        ["颗粒物", "数据一致性"],
        ["更换仪器", "数据一致性"]
      ],
      expandedTerms: [
        "HJ 817",
        "HJ 817-2018",
        "HJ817",
        "环境空气颗粒物连续自动监测系统运行和质控技术规范",
        "颗粒物自动站运行质控",
        "零值负值",
        "流量审核",
        "平行性",
        "颗粒物数据质控",
        "更换仪器数据一致性",
        "数据一致性检查",
        "环境参数检查",
        "温度气压湿度",
        "数据有效性"
      ],
      pinnedStandards: ["HJ 817", "HJ 817-2018"],
      rankingSignals: ["ambient_pm_operation_qaqc_question", "qaqc_question"],
      factTypeBoosts: { validity_rule: 6, technical_parameter: 5, method_step: 4 },
      documentRoleBoosts: { qa_qc: 6, monitoring_method: 4, standard: 2 },
      evidenceRoleBoosts: { method: 5, current_authority: 3 },
      chunkTermBoosts: {
        负值: 6,
        零值: 5,
        流量审核: 6,
        平行性: 5,
        数据有效性: 4,
        数据一致性: 6,
        更换仪器: 5,
        环境参数: 5,
        温度: 3,
        气压: 3,
        湿度: 3
      }
    },
    {
      id: "ambient_pm_acceptance_comparison_question",
      priority: 109,
      anyText: ["颗粒物", "PM10", "PM2.5", "比对调试", "有效数据对", "安装验收"],
      anyTermGroups: [
        ["颗粒物", "比对调试"],
        ["PM2.5", "比对调试"],
        ["PM10", "比对调试"],
        ["颗粒物", "有效数据对"],
        ["安装验收", "有效数据"]
      ],
      expandedTerms: [
        "HJ 655",
        "HJ 655-2013",
        "HJ655",
        "环境空气颗粒物连续自动监测系统安装和验收技术规范",
        "颗粒物自动站安装验收",
        "比对调试",
        "有效数据对"
      ],
      pinnedStandards: ["HJ 655", "HJ 655-2013"],
      standardClusters: ["ambient_auto_monitoring_acceptance"],
      rankingSignals: ["ambient_pm_acceptance_comparison_question", "monitoring_method_question"],
      factTypeBoosts: { technical_parameter: 6, method_step: 5, validity_rule: 4 },
      documentRoleBoosts: { standard: 6, monitoring_method: 3, qa_qc: 2 },
      evidenceRoleBoosts: { method: 5, current_authority: 3 },
      chunkTermBoosts: { 比对调试: 7, 有效数据对: 7, 安装验收: 5, 颗粒物: 4 }
    },
    {
      id: "ambient_pm_technical_method_question",
      priority: 106,
      anyText: [
        "颗粒物",
        "PM10",
        "PM2.5",
        "参比方法",
        "比对",
        "斜率",
        "截距",
        "相关系数",
        "技术要求",
        "检测方法",
        "采购检测",
        "采购验收",
        "设备采购",
        "性能指标"
      ],
      anyTermGroups: [
        ["颗粒物", "技术要求"],
        ["颗粒物", "检测方法"],
        ["PM10", "技术要求"],
        ["PM2.5", "技术要求"],
        ["PM2.5", "采购检测"],
        ["PM2.5", "性能指标"],
        ["自动监测仪", "采购检测"],
        ["自动监测仪", "性能指标"],
        ["参比方法", "比对"],
        ["斜率", "截距"],
        ["相关系数", "比对"]
      ],
      expandedTerms: [
        "HJ 653",
        "HJ 653-2021",
        "HJ653",
        "环境空气颗粒物连续自动监测系统技术要求及检测方法",
        "参比方法比对",
        "斜率 截距 相关系数",
        "颗粒物自动监测仪采购检测",
        "颗粒物自动监测仪性能指标",
        "PM10 PM2.5 自动监测技术要求",
        "PM10 PM2.5 自动监测系统检测项目"
      ],
      pinnedStandards: ["HJ 653", "HJ 653-2021"],
      rankingSignals: ["ambient_pm_technical_method_question", "monitoring_method_question"],
      factTypeBoosts: { technical_parameter: 6, method_step: 5, formula: 4 },
      documentRoleBoosts: { monitoring_method: 5, standard: 3 },
      evidenceRoleBoosts: { method: 5 },
      chunkTermBoosts: {
        参比方法: 6,
        比对: 6,
        斜率: 5,
        截距: 5,
        相关系数: 5,
        技术要求: 4,
        检测项目: 7,
        性能指标: 7
      }
    },
    {
      id: "ambient_auto_monitoring_qaqc_family_question",
      priority: 107,
      anyText: [
        "环境空气",
        "自动站",
        "自动监测",
        "运行质控",
        "日常质控",
        "安装验收",
        "验收",
        "新建",
        "站房",
        "联网",
        "试运行",
        "标准族",
        "区别",
        "职责分工",
        "气态",
        "颗粒物",
        "数据异常"
      ],
      anyTermGroups: [
        ["环境空气", "自动站", "运行质控"],
        ["环境空气", "自动监测", "运行质控"],
        ["自动站", "运行质控"],
        ["自动站", "数据异常"],
        ["自动站", "验收"],
        ["自动站", "站房"],
        ["自动站", "联网"],
        ["自动站", "试运行"],
        ["新建", "自动站"],
        ["日常质控", "安装验收"],
        ["运行一年", "安装验收"],
        ["自动监测", "安装验收", "运行质控"],
        ["安装验收", "运行质控", "区别"],
        ["运行质控", "标准族"]
      ],
      expandedTerms: [
        "HJ 818",
        "HJ 818-2018",
        "HJ 817",
        "HJ 817-2018",
        "HJ 193",
        "HJ 193-2013",
        "HJ 655",
        "HJ 655-2013",
        "HJ 653",
        "HJ 653-2021",
        "HJ 654",
        "HJ 654-2013",
        "环境空气自动监测运行质控",
        "环境空气自动监测安装验收",
        "环境空气自动监测技术要求",
        "自动站验收站房联网试运行",
        "自动站日常质控安装验收职责分工",
        "气态污染物运行质控",
        "颗粒物运行质控"
      ],
      pinnedStandards: ["HJ 818", "HJ 818-2018", "HJ 817", "HJ 817-2018", "HJ 193", "HJ 193-2013", "HJ 655", "HJ 655-2013"],
      rankingSignals: ["ambient_auto_monitoring_qaqc_family_question", "qaqc_question"],
      factTypeBoosts: { technical_parameter: 5, validity_rule: 5, method_step: 4 },
      documentRoleBoosts: { qa_qc: 6, monitoring_method: 4, standard: 3 },
      evidenceRoleBoosts: { method: 5, current_authority: 3 },
      chunkTermBoosts: { 运行质控: 6, 安装验收: 5, 标准族: 4, 区别: 3 }
    },
    {
      id: "ambient_gas_operation_qaqc_question",
      priority: 105,
      anyText: [
        "气态",
        "气态仪器",
        "零点漂移",
        "量程漂移",
        "零跨",
        "运行质控",
        "质控频次",
        "SO2",
        "NO2",
        "O3",
        "臭氧",
        "CO",
        "气态负值",
        "校准周期"
      ],
      anyTermGroups: [
        ["气态", "零点漂移"],
        ["气态", "量程漂移"],
        ["气态", "质控"],
        ["气态", "频次"],
        ["气态", "负值"],
        ["气态", "校准周期"],
        ["气态仪器", "零点"],
        ["气态仪器", "量程"],
        ["SO2", "负值"],
        ["SO2", "质控"],
        ["SO2", "小时值"],
        ["NO2", "质控"],
        ["O3", "质控"],
        ["臭氧", "质控"],
        ["臭氧", "时段"],
        ["臭氧", "检查项目"],
        ["臭氧", "零跨"],
        ["O3", "时段"],
        ["CO", "质控"]
      ],
      expandedTerms: [
        "HJ 818",
        "HJ 818-2018",
        "HJ818",
        "环境空气气态污染物连续自动监测系统运行和质控技术规范",
        "气态污染物运行质控",
        "零点漂移",
        "量程漂移",
        "气态污染物零值负值",
        "SO2负值处理",
        "气态仪器校准周期",
        "零跨检查",
        "质控频次",
        "臭氧自动监测运行质控",
        "O3自动监测运行质控",
        "臭氧零跨检查时段",
        "运行质控时段要求"
      ],
      pinnedStandards: ["HJ 818", "HJ 818-2018"],
      rankingSignals: ["ambient_gas_operation_qaqc_question", "qaqc_question"],
      factTypeBoosts: { technical_parameter: 6, validity_rule: 5, method_step: 4 },
      documentRoleBoosts: { qa_qc: 6, monitoring_method: 4, standard: 2 },
      evidenceRoleBoosts: { method: 5, current_authority: 3 },
      chunkTermBoosts: {
        零点漂移: 6,
        量程漂移: 6,
        零跨: 5,
        质控频次: 5,
        负值: 6,
        零值: 5,
        校准周期: 5,
        气态污染物: 4,
        SO2: 4,
        臭氧: 5,
        O3: 5,
        时段: 4
      }
    },
    {
      id: "ambient_gas_acceptance_and_technical_question",
      priority: 104,
      anyText: ["气态", "SO2", "NO2", "O3", "CO", "安装验收", "调试检测", "技术要求", "检测方法", "设备采购", "采购验收", "采购检测"],
      anyTermGroups: [
        ["气态", "安装验收"],
        ["气态", "调试检测"],
        ["气态", "技术要求"],
        ["气态", "检测方法"],
        ["设备采购", "验收"],
        ["采购验收", "运行质控"],
        ["SO2", "NO2"],
        ["SO2", "O3"],
        ["NO2", "O3"],
        ["SO2", "CO"]
      ],
      expandedTerms: [
        "HJ 193",
        "HJ 193-2013",
        "HJ 654",
        "HJ 654-2013",
        "环境空气气态污染物连续自动监测系统安装验收技术规范",
        "环境空气气态污染物连续自动监测系统技术要求及检测方法",
        "气态仪器调试检测",
        "气态仪器采购验收",
        "气态仪器采购检测",
        "气态自动监测性能指标"
      ],
      pinnedStandards: ["HJ 193", "HJ 193-2013", "HJ 654", "HJ 654-2013"],
      rankingSignals: ["ambient_gas_acceptance_and_technical_question", "monitoring_method_question"],
      factTypeBoosts: { technical_parameter: 6, method_step: 5, formula: 3 },
      documentRoleBoosts: { monitoring_method: 5, standard: 4, qa_qc: 2 },
      evidenceRoleBoosts: { method: 5 },
      chunkTermBoosts: { 安装验收: 6, 调试检测: 6, 技术要求: 5, 检测方法: 5, 性能指标: 5 }
    },
    {
      id: "fixed_source_cems_data_transmission_question",
      priority: 123,
      anyText: ["CEMS", "在线监测", "在线监控", "数据传输", "数据链路", "数采仪", "传输协议", "固定污染源"],
      anyTermGroups: [
        ["CEMS", "数据传输"],
        ["在线监测", "数据传输"],
        ["在线监控", "数据传输"],
        ["现场检查", "数据链路"],
        ["在线", "数据链路"],
        ["数采仪", "传输"],
        ["污染物", "数据传输"]
      ],
      expandedTerms: [
        "HJ 212",
        "HJ 212-2025",
        "HJ212",
        "污染物在线监控系统数据传输标准",
        "在线监测数据传输",
        "CEMS数据传输",
        "数据链路",
        "数采仪传输协议"
      ],
      pinnedStandards: ["HJ 212", "HJ 212-2025"],
      rankingSignals: ["fixed_source_cems_data_transmission_question"],
      factTypeBoosts: { technical_parameter: 5, method_step: 4 },
      documentRoleBoosts: { standard: 5, technical_regulation: 4, monitoring_method: 3 },
      evidenceRoleBoosts: { method: 5, current_authority: 4 },
      chunkTermBoosts: { 数据传输: 7, 数采仪: 5, 传输协议: 5, 在线监控: 4 }
    },
    {
      id: "fixed_source_cems_operation_or_technical_question",
      priority: 121,
      anyText: [
        "CEMS",
        "固定污染源",
        "固定源",
        "烟气",
        "运行维护",
        "运行质控",
        "技术要求",
        "检测方法",
        "仪器检测方法",
        "连续监测",
        "校准",
        "维护",
        "无效数据",
        "数据审核"
      ],
      anyTermGroups: [
        ["固定污染源", "运行"],
        ["固定污染源", "技术要求"],
        ["固定污染源", "检测方法"],
        ["固定源", "CEMS"],
        ["烟气", "运行"],
        ["烟气", "技术要求"],
        ["CEMS", "运行"],
        ["CEMS", "技术要求"],
        ["CEMS", "校准"],
        ["CEMS", "维护"],
        ["CEMS", "无效数据"],
        ["固定源", "校准"],
        ["固定源", "维护"],
        ["固定源", "无效数据"]
      ],
      expandedTerms: [
        "HJ 75",
        "HJ 75-2017",
        "HJ 76",
        "HJ 76-2017",
        "固定污染源烟气排放连续监测技术规范",
        "固定污染源烟气排放连续监测系统技术要求及检测方法",
        "CEMS运行维护",
        "CEMS校准维护",
        "CEMS无效数据审核",
        "固定源CEMS校准维护",
        "固定源CEMS无效数据审核",
        "烟气CEMS技术要求"
      ],
      pinnedStandards: ["HJ 75", "HJ 75-2017", "HJ 76", "HJ 76-2017"],
      rankingSignals: ["fixed_source_cems_operation_or_technical_question"],
      factTypeBoosts: { technical_parameter: 6, method_step: 5, validity_rule: 4 },
      documentRoleBoosts: { standard: 5, monitoring_method: 4, technical_regulation: 4 },
      evidenceRoleBoosts: { method: 5, current_authority: 4 },
      chunkTermBoosts: { 固定污染源: 6, 固定源: 5, 烟气: 6, CEMS: 6, 运行维护: 5, 校准: 4, 无效数据: 4, 技术要求: 5 }
    },
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
      anyText: ["AQI", "IAQI", "空气质量指数", "指数规则", "实时", "播报", "日报", "实时报", "日报和实时报", "日报技术规定"],
      anyTermGroups: [
        ["实时", "空气质量"],
        ["空气质量", "播报"],
        ["指数", "规则"],
        ["日报", "实时报"]
      ],
      expandedTerms: [
        "HJ 633",
        "HJ 633-2026",
        "HJ 633-2012",
        "环境空气质量指数",
        "空气质量日报",
        "空气质量实时报",
        "实时空气质量播报",
        "AQI指数规则"
      ],
      pinnedStandards: ["HJ 633", "HJ 633-2026"],
      standardClusters: ["ambient_quality_core"],
      rankingSignals: ["aqi_reporting_question"],
      factTypeBoosts: { formula: 4, technical_parameter: 2 }
    },
    {
      id: "ambient_air_quality_assessment_question",
      priority: 118,
      anyText: ["评价技术规范", "达标评价", "评价报告", "报告依据", "空气质量评价", "AQI", "口径"],
      anyTermGroups: [["达标评价", "AQI"], ["达标评价", "口径"], ["空气质量评价", "AQI"], ["评价技术规范"]],
      expandedTerms: ["HJ 663", "HJ 663-2026", "环境空气质量评价技术规范", "达标评价技术规范"],
      pinnedStandards: ["HJ 663", "HJ 663-2026"],
      standardClusters: ["ambient_quality_core"],
      rankingSignals: ["ambient_air_quality_assessment_question"],
      factTypeBoosts: { validity_rule: 4, formula: 3, limit_value: 2 }
    },
    {
      id: "monitoring_method_question",
      priority: 70,
      anyText: ["环境空气", "自动站", "监测方法", "采样", "分析方法", "测定", "检出限", "公式", "转换炉", "零跨"],
      expandedTerms: ["环境空气监测方法", "环境空气质量监测规范", "采样", "质量保证", "质量控制", "转换炉效率", "转换效率", "转换器效率"],
      standardClusters: [
        "ambient_auto_monitoring_operation_qaqc",
        "ambient_gas_measurement_methods",
        "ambient_manual_sampling_analysis",
        "ambient_auto_monitoring_acceptance"
      ],
      rankingSignals: ["monitoring_method_question", "qaqc_question"],
      factTypeBoosts: { technical_parameter: 5, method_step: 4, validity_rule: 3 },
      documentRoleBoosts: { monitoring_method: 4, qa_qc: 4, standard: 2 },
      chunkTermBoosts: { 质控: 4, 质量控制: 4, 校准: 3, 采样: 3, 转换炉效率: 5, 转换效率: 5, 转换器效率: 5 }
    },
    {
      id: "pollution_source_auto_monitoring_enforcement",
      priority: 122,
      anyText: [
        "污染源自动监控",
        "自动监控设施",
        "固定源自动监控",
        "现场监督检查",
        "现场检查",
        "19号令",
        "28号令",
        "自动监控管理办法",
        "在线监控",
        "在线设备",
        "停运",
        "拆除",
        "故障",
        "数据异常",
        "排污单位",
        "运维单位",
        "管理职责",
        "管理责任",
        "运维责任",
        "备案",
        "联网",
        "设备更换",
        "采样探头"
      ],
      anyTermGroups: [
        ["自动监控设施", "现场检查"],
        ["自动监控设施", "现场监督检查"],
        ["现场检查办法", "管理办法"],
        ["自动监控管理", "现场检查"],
        ["管理职责", "自动监控"],
        ["职责分工", "自动监控"],
        ["现场检查", "程序"],
        ["固定源自动监控", "现场检查"],
        ["自动监控", "故障"],
        ["自动监控", "报告"],
        ["自动监控", "恢复"],
        ["自动监控", "停运"],
        ["自动监控", "拆除"],
        ["在线设备", "停运"],
        ["在线设备", "运维"],
        ["在线监控", "排污单位"],
        ["运维单位", "排污单位"],
        ["排污单位", "自动监控"],
        ["运维单位", "自动监控"],
        ["在线数据", "异常"],
        ["在线监控数据", "异常"],
        ["离线", "现场检查"],
        ["现场", "违法"],
        ["现场", "处罚"],
        ["采样探头", "拆除"],
        ["采样探头", "位置"],
        ["故障", "报告"],
        ["先拆", "备案"],
        ["设备更换", "备案"],
        ["设备更换", "联网"]
      ],
      expandedTerms: [
        "污染源自动监控设施现场监督检查办法",
        "现场检查办法",
        "自动监控现场检查办法",
        "环境保护部令第19号",
        "环保部19号令",
        "污染源自动监控管理办法",
        "自动监控管理办法",
        "自动监控管理",
        "国家环保总局令第28号",
        "重点污染源自动监控系统"
      ],
      pinnedStandards: ["环境保护部令第19号", "国家环保总局令第28号"],
      standardClusters: ["pollution_source_auto_monitoring_enforcement"],
      rankingSignals: ["pollution_source_auto_monitoring_enforcement"],
      documentRoleBoosts: { regulation: 5, law: 4, technical_regulation: 4, monitoring_method: 2 },
      evidenceRoleBoosts: { current_authority: 5, method: 2 },
      chunkTermBoosts: {
        故障: 4,
        报告: 4,
        恢复: 4,
        停运: 4,
        离线: 4,
        拆除: 4,
        自动监控设施: 5,
        数据异常: 5,
        弄虚作假: 5,
        在线数据: 5,
        在线监控: 5,
        现场检查: 6,
        处罚依据: 5,
        程序证据: 5,
        风险提示: 4,
        备案: 4,
        联网: 4,
        检查清单: 5,
        排污单位: 5,
        管理职责: 5,
        管理责任: 5,
        运维责任: 4,
        主体责任: 4,
        运行维护: 4
      }
    },
    {
      id: "ambient_statistics_reporting_question",
      priority: 65,
      anyText: ["公报", "月报", "年报", "月排名", "排名", "统计", "城市数量", "评价城市", "同比", "环比", "年度报告"],
      expandedTerms: [
        "环境空气质量公报",
        "环境空气质量月报",
        "全国城市空气质量报告",
        "全国城市空气质量月报",
        "168城排名",
        "城市空气质量排名",
        "环境空气质量年报",
        "统计期",
        "评价城市",
        "城市数量"
      ],
      standardClusters: ["ambient_statistics_reporting"],
      rankingSignals: ["ambient_statistics_reporting_question"],
      documentRoleBoosts: { statistics: 5, whitepaper: 2, official_explanation: 2 },
      evidenceRoleBoosts: { statistics: 5, official_explanation: 2 },
      chunkTermBoosts: { 公报: 3, 月报: 3, 年报: 3, 统计: 4, 城市: 2, 评价城市: 4 }
    },
    {
      id: "ambient_limit_source_authority_boundary_question",
      priority: 119,
      anyText: ["公报", "月报", "限值", "现行标准正文", "替代现行", "强制依据"],
      anyTermGroups: [
        ["公报", "限值"],
        ["月报", "限值"],
        ["公报", "标准正文"],
        ["月报", "标准正文"],
        ["限值", "现行标准"]
      ],
      expandedTerms: ["GB 3095", "GB 3095-2026", "环境空气质量标准", "现行环境空气质量标准", "浓度限值"],
      pinnedStandards: ["GB 3095", "GB 3095-2026"],
      standardClusters: ["ambient_quality_core"],
      rankingSignals: [
        "ambient_limit_source_authority_boundary_question",
        "ambient_air_quality_limit_question",
        "authority_boundary_question"
      ],
      factTypeBoosts: { limit_value: 6, status_rule: 3 },
      documentRoleBoosts: { standard: 7, statistics: 1, official_explanation: 1 },
      evidenceRoleBoosts: { current_authority: 6, method: 3, statistics: 1 },
      chunkTermBoosts: { 限值: 6, 浓度限值: 6, 现行标准: 5, 公报: 2, 月报: 2 }
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
