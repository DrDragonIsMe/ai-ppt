// scripts/marketing/angles.mjs — 营销大纲内置角度集（angleSet）单一数据源。
// 一个角度 = 一份独立 deck 的叙事立场：thesis 互不重复、取材关键词各自收敛，
// 这样「从不同角度介绍多源信息」才成立，而不是同一批素材换六个标题。
// 扩充角度集 = 在 ANGLE_SETS 里加一条，前端与生成侧都按 id 取，无需改调用方。

export const DEFAULT_ANGLE_SET = 'marketing-standard';

/**
 * 每个角度的字段：
 *  - key         角度标识，进入 deckName（mkt-<key>-<slug>）与 sourceSelection.angleKey
 *  - title       角度标题（deck 主标题的组成部分）
 *  - thesis      该角度的默认论点（LLM 可用其润色版，但不得与其他角度重复；兜底时直接采用）
 *  - lens        写给 LLM 的取材视角说明（这一角度要回答什么问题）
 *  - keywords    确定性取材打分词（无 LLM 时靠它把素材分桶，也用于给 LLM 提示相关性）
 *  - audience    该角度天然面对的听众（可被 product.audience 覆盖）
 */
export const ANGLE_SETS = {
  [DEFAULT_ANGLE_SET]: [
    {
      key: 'pain',
      title: '客户痛点',
      thesis: '客户今天的真实困境不在工具数量，而在信息分散、流程重复、人效难以衡量。',
      lens: '只谈问题不谈方案：把素材中出现的客户抱怨、低效环节、隐性成本、失败尝试挑出来，让客户先点头。',
      keywords: ['痛点', '问题', '挑战', '困难', '成本', '低效', '重复', '手工', '瓶颈', '风险', 'pain', 'challenge', 'problem', 'cost'],
      audience: '业务负责人 / 一线管理者',
    },
    {
      key: 'capability',
      title: '产品能力',
      thesis: '产品把分散的动作收敛成一条可复用的工作流，能力之间互相喂数据而不是并列的功能清单。',
      lens: '谈产品具体能做什么：功能、流程、接口、自动化环节。只讲素材里写明存在的能力，禁止补全想象中的特性。',
      keywords: ['功能', '能力', '支持', '实现', '模块', '自动化', '流程', '平台', '引擎', '集成', 'feature', 'capab', 'support'],
      audience: '产品 / 技术评估者',
    },
    {
      key: 'scenario',
      title: '行业场景',
      thesis: '同一套能力在不同行业、不同角色身上有不同的落法，场景越具体，价值越可验证。',
      lens: '谈用在哪儿：行业、岗位、使用时机、上下游配合方式。优先挑素材里带具体场景描述的条目。',
      keywords: ['场景', '行业', '案例', '应用', '用法', '客户', '部门', '团队', '培训', '招聘', '销售', 'scenario', 'industry', 'use case'],
      audience: '同行业决策者',
    },
    {
      key: 'diff',
      title: '差异化竞争',
      thesis: '与常见替代方案（自研、表格、通用大模型、同类工具）相比，差别在数据是否沉淀与流程是否闭环。',
      lens: '谈为什么是我们：对比、独有设计、替代方案的短板。只能引用素材里出现过的对比事实，不得编造竞品数据。',
      keywords: ['差异', '区别', '优势', '相比', '对比', '传统', '通用', '自研', '竞品', '壁垒', 'differentiat', 'versus', 'compare'],
      audience: '正在横向比选方案的采购方',
    },
    {
      key: 'roi',
      title: 'ROI 价值',
      thesis: '可衡量的收益来自省下的人时与缩短的周期，投入产出比要在具体环节上算，而不是笼统谈提效。',
      lens: '谈值不值：数字、百分比、人时、周期、单价、回收期。素材里没有数字就不要造数字，改为讲清度量口径。',
      keywords: ['效率', '提升', '节省', '成本', '时间', '周期', '回报', 'roi', '增长', '转化', '百分比', '倍', '小时', 'efficiency', 'save'],
      audience: '财务与预算审批人',
    },
    {
      key: 'proof',
      title: '成功案例与落地路径',
      thesis: '从试点到铺开的阻力在流程改造而非技术本身，按阶段推进、每一步都有可验收的产出。',
      lens: '谈怎么开始：已验证案例、实施步骤、周期、配置要点、常见坑与规避方式，最后落到一个可执行的启动动作。',
      keywords: ['落地', '实施', '步骤', '阶段', '上线', '部署', '迁移', '试点', '培训', '成功', '路径', 'rollout', 'implement', 'onboard'],
      audience: '项目落地负责人 / IT',
    },
  ],
};

export function listAngleSets() {
  return Object.keys(ANGLE_SETS);
}

/** 取角度集；未注册的 id 一律回退默认集（避免前端传错就直接 500）。 */
export function getAngleSet(id) {
  return ANGLE_SETS[id] || ANGLE_SETS[DEFAULT_ANGLE_SET];
}

export function angleSetId(id) {
  return ANGLE_SETS[id] ? id : DEFAULT_ANGLE_SET;
}

/** 按 key 找角度定义；找不到返回 null。 */
export function findAngle(setId, key) {
  return getAngleSet(setId).find((a) => a.key === key) || null;
}
