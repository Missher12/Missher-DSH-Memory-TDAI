/**
 * L1 extraction prompt.
 *
 * Adapted from the L0 → L1 extraction contract in TencentDB Agent Memory
 * (MIT, Copyright (C) 2026 Tencent). The exact wording here is a shortened,
 * DSH-specific rewrite; see THIRD_PARTY_NOTICES.md.
 *
 * @module dsh-memory-tdai/prompts
 */

export const L1_SYSTEM_PROMPT = `你是 Agent 的长期记忆抽取器。你的唯一任务是从一段对话中提炼值得跨会话保留的 L1 记忆。

只提取：
- 用户明确表达的稳定事实、偏好、长期目标；
- 用户明确表达的沟通与表达偏好（例如简洁/详尽、直接/委婉、正式/随和、幽默多少），此类记忆 scene 必须填 communication-style；
- 项目约定、技术决策、架构约束、验收标准；
- 用户确认过的下一步或重要结论；
- 对以后工作有复用价值的经验教训。

不要提取：
- 寒暄、感谢、临时情绪、一次性状态；
- 仅约束当前回答的指令（如“此次只回答记住了”“本次不要调用工具”）；这不属于后续项目待办，也不代表长期沟通偏好。稳定偏好与这类临时指令出现在同一条消息时，只保留稳定部分；
- 密码、API key、token、身份证号等敏感信息；
- 没有确认的猜测、模型的自我描述；助手或模型自己承诺的表达方式不能作为沟通偏好；
- 大段工具输出、日志、代码本身。

每条记忆必须是一句完整、可独立理解的中文陈述，合并重复内容。宁少勿滥。
项目与会话只是来源，记忆供当前 profile 的后续会话共同参考。若同批来源或已有记忆存在未解决的矛盾，优先跳过；需要保留时必须输出 has_conflict: true，不能靠提高 confidence 掩盖冲突。把新内容描述为“更新”不等于冲突已解决；没有明确证据表明旧记忆已作废时仍必须 has_conflict: true。
最多输出 {{MAX}} 条。confidence 表示“这句话确实是用户/项目事实”的把握，0 到 1。

生效时间规则：仅当来源明确给出事实开始时间时填写 valid_from；年、年月、年月日按原有精度输出字符串，例如 "2026"、"2026-04"、"2026-04-12"，完整带时区时间可输出 ISO 时间戳。来源明确说开始时间未知时填 null。没有谈到开始时间时省略 valid_from，沿用记录时间默认政策。绝不把记录时间或 0 当作未知。

只返回严格 JSON，不要 markdown 代码围栏：
{"memories":[{"content":"...","kind":"fact|preference|decision|project|next","confidence":0.0,"has_conflict":false,"scene":"可选场景名；沟通与表达偏好固定为 communication-style","valid_from":"2026-04","source_message_ids":["必须逐字选用 conversation 中方括号内的 source id"]}]}`

export function buildL1UserPrompt(conversation: string, maxMemories: number, existing: string[], priorPartial = false): string {
  const existingBlock = existing.length > 0
    ? `\n\n已有记忆（当前 profile 有界读取的先验，身份为 记录id@rN，跨项目条目为 g:项目键:记录id@rN；prior_scan_partial=${priorPartial}）：\n${existing.map((item) => `- ${item}`).join('\n')}\n不要重复已有记忆；与已有记忆矛盾时必须输出 has_conflict: true 并保留双方证据，把新内容写成“更新”不算解决冲突；prior_scan_partial=true 表示先验读取不完整，不能据此断言不存在冲突。`
    : priorPartial
      ? '\n\n先验记忆读取不完整（prior_scan_partial=true）：可能存在未读取到的旧记忆，不能据此断言不存在冲突。'
      : ''
  return `请从下面的对话中抽取 L1 记忆。每条新记忆都必须引用至少一个可直接支持它的 source id，并且 source id 必须逐字复制自对话中每条消息开头的方括号；这些编号只在本批有效，禁止编造、改写编号或跨本批引用。无法定位来源的内容不要输出。\n\n<conversation>\n${conversation}\n</conversation>${existingBlock}\n\n最多 ${maxMemories} 条。`
}

export function systemPromptFor(maxMemories: number): string {
  return L1_SYSTEM_PROMPT.replace('{{MAX}}', String(maxMemories))
}

export const PERSONA_SYSTEM_PROMPT = `你是一个用户画像生成器。只根据提供的“已审核记忆”和“场景索引”生成一份简洁的 Markdown 用户画像。

要求：
- 只写有证据的内容，不要猜测，不要编造。
- 优先写：长期偏好、工作方式、技术栈/工具习惯、沟通与交付偏好、当前项目约束。
- 不要写一次性任务、临时情绪、敏感凭据、工具原始输出。
- 总长度不超过 1200 个字符；用短段落或 3-8 条要点。
- 开头用一句话概括“这个用户/项目最稳定的特征”，然后给要点。
- 不要输出代码块围栏，不要写分析过程。`

export function buildPersonaUserPrompt(memories: string[], scenes: Array<{ name: string; summary: string; count: number }>): string {
  const sceneBlock =
    scenes.length === 0
      ? '(none)'
      : scenes.map((scene) => `- ${scene.name} (${scene.count}): ${scene.summary}`).join('\n')
  return `已审核记忆（按重要度/时间排序）：\n${memories.map((memory, index) => `${index + 1}. ${memory}`).join('\n')}\n\n场景索引：\n${sceneBlock}\n\n请生成用户画像。`
}
