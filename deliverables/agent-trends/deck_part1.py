# -*- coding: utf-8 -*-
"""第 1-4 页：封面、执行摘要、范式演进、自主性分级。"""
from pptx.enum.text import PP_ALIGN
from pptx.enum.shapes import MSO_SHAPE


def build(prs, L):
    # ============ 01 封面 ============
    s = L.page(prs)
    for d, col in [(4.9, L.RGBColor.from_string('16283F')),
                   (3.6, L.RGBColor.from_string('1B3350')),
                   (2.35, L.RGBColor.from_string('22405F'))]:
        L.ellipse(s, 9.55 + (4.9 - d) / 2, 1.30 + (4.9 - d) / 2, d, fill=None, line=col)
    L.ellipse(s, 11.28, 3.05, 0.34, fill=L.ACCENT)
    L.ellipse(s, 9.70, 1.47, 0.20, fill=L.ACCENT2)
    L.ellipse(s, 13.04, 4.67, 0.16, fill=L.ACCENT3)
    L.ellipse(s, 9.84, 4.81, 0.13, fill=L.ACCENT4)
    L.arrow(s, 9.84, 1.50, 11.33, 3.15, color=L.RGBColor.from_string('2A4A6B'), width=1.25)
    L.arrow(s, 11.40, 3.23, 13.00, 4.69, color=L.RGBColor.from_string('2A4A6B'), width=1.25)

    L.rect(s, 1.05, 2.02, 0.92, 0.06, fill=L.ACCENT)
    L.tbox(s, 1.05, 2.32, 8.6, 1.5,
           [{'text': 'Agent 发展趋势', 'size': 55, 'bold': True, 'color': L.TEXT,
             'line_spacing': 0.98}])
    L.tbox(s, 1.05, 3.58, 8.3, 0.9,
           [{'text': '从对话式助手到自主执行体：技术栈、生态协议与生产化落地',
             'size': 17.5, 'color': L.MUTED, 'line_spacing': 1.35}])
    L.hline(s, 1.05, 4.68, 7.4, L.LINE, 1.0)
    L.tbox(s, 1.05, 4.88, 8.3, 1.3, [
        {'text': '核心命题', 'size': 11, 'bold': True, 'color': L.ACCENT, 'space_after': 6},
        {'text': '价值锚点已从「回答得多好」转向「任务能否闭环交付」；竞争点从模型能力'
                 '转向上下文、协议与生产可靠性。',
         'size': 13.5, 'color': L.TEXT, 'line_spacing': 1.45},
    ])
    L.tbox(s, 1.05, 6.50, 8.3, 0.4,
           [{'text': '10 页速览  ·  面向技术决策者  ·  2026 观察', 'size': 11, 'color': L.DIM}])
    L.notes(s, '开场：本报告用 10 页回答三个问题——Agent 走到哪一步了、技术栈的胜负手在哪、'
               '企业该从哪里切入。核心结论一句话：竞争点已从"回答质量"转移到"任务闭环的交付能力"。')

    # ============ 02 执行摘要 ============
    s = L.page(prs)
    L.header(s, 'EXECUTIVE SUMMARY', '执行摘要：四条核心判断', 2)
    items = [
        ('01', '从「生成内容」到「完成工作」',
         '价值锚点从回答质量转向任务闭环率与可交付结果，衡量标准变成"省了多少人时"。', L.ACCENT),
        ('02', '上下文工程取代提示词工程',
         '记忆、检索、工具描述与状态压缩共同决定能力上限，长上下文 ≠ 有效上下文。', L.ACCENT2),
        ('03', '协议层正在收敛',
         'MCP 统一工具接入、A2A 类协议打通智能体互操作，"插件"正在变成"基础设施"。', L.ACCENT3),
        ('04', '生产化差距是主战场',
         '可靠性、可观测性、权限治理与任务级评测，决定谁能从演示真正走到规模化。', L.ACCENT4),
    ]
    for (num, title, desc, col), (cx, cy) in zip(items, [(0.75, 1.90), (6.98, 1.90),
                                                         (0.75, 3.56), (6.98, 3.56)]):
        L.card(s, cx, cy, 5.60, 1.50, fill=L.CARD, line=L.LINE)
        L.rect(s, cx, cy + 0.16, 0.055, 1.18, fill=col)
        L.tbox(s, cx + 0.28, cy + 0.18, 0.72, 0.4,
               [{'text': num, 'size': 20, 'bold': True, 'color': col}])
        L.tbox(s, cx + 1.00, cy + 0.20, 4.38, 0.34,
               [{'text': title, 'size': 15.5, 'bold': True, 'color': L.TEXT}])
        L.tbox(s, cx + 1.00, cy + 0.62, 4.38, 0.74,
               [{'text': desc, 'size': 11.5, 'color': L.MUTED, 'line_spacing': 1.32}])
    L.card(s, 0.75, 5.36, 11.83, 1.34, fill=L.CARD_2, line=L.RGBColor.from_string('2C4260'))
    L.rect(s, 0.75, 5.36, 11.83, 0.055, fill=L.ACCENT)
    L.tbox(s, 1.15, 5.62, 11.1, 0.9, [
        {'text': '一句话结论', 'size': 11, 'bold': True, 'color': L.ACCENT, 'space_after': 5},
        {'text': '2026 年的竞争点不再是「能不能做出 Agent」，而是能否稳定、可审计、'
                 '低成本地把长程任务交付出去。',
         'size': 14, 'bold': True, 'color': L.TEXT, 'line_spacing': 1.3},
    ])
    L.notes(s, '四条判断可概括为：价值转移、能力上限转移、生态协议收敛、竞争落到生产化。'
               '记忆口诀：价值 → 上下文 → 协议 → 可靠性。')

    # ============ 03 范式演进 ============
    s = L.page(prs)
    L.header(s, 'EVOLUTION', '范式演进：从会聊天到会干活', 3)
    stages = [
        ('2022', '对话式', 'Chatbot', '单轮文本生成，人负责执行', L.ACCENT2),
        ('2023', '辅助式', 'Copilot', '嵌入既有工作流，人机协同补全', L.ACCENT2),
        ('2024', '工具化', 'Function Calling', '调用外部工具完成原子动作', L.ACCENT),
        ('2025', '编排式', 'Agentic Workflow', '流程编排 + 多智能体并行分工', L.ACCENT),
        ('2026+', '自主化', 'Autonomous', '长程任务、持续记忆、自我纠错', L.ACCENT3),
    ]
    base_y = 3.44
    L.hline(s, 1.05, base_y, 11.35, L.GRID, 1.5)
    xs = [1.42, 3.72, 6.02, 8.32, 10.62]
    for i, ((year, name, en, desc, col), x) in enumerate(zip(stages, xs)):
        L.ellipse(s, x, base_y - 0.115, 0.23, fill=col)
        L.ellipse(s, x + 0.045, base_y - 0.07, 0.14, fill=L.BG)
        block = [
            {'text': year, 'size': 12, 'bold': True, 'color': col, 'space_after': 3},
            {'text': name, 'size': 15, 'bold': True, 'color': L.TEXT, 'space_after': 2},
            {'text': en, 'size': 10, 'color': L.DIM, 'space_after': 4},
            {'text': desc, 'size': 10.5, 'color': L.MUTED, 'line_spacing': 1.25},
        ]
        if i % 2 == 0:
            cy = base_y - 1.72
            L.tbox(s, x - 1.05, cy, 2.30, 1.30, block, align=PP_ALIGN.CENTER)
            L.vline(s, x + 0.115, cy + 1.36, base_y - 0.12 - (cy + 1.36), L.GRID, 1.0)
        else:
            cy = base_y + 0.44
            L.tbox(s, x - 1.05, cy, 2.30, 1.30, block, align=PP_ALIGN.CENTER)
            L.vline(s, x + 0.115, base_y + 0.12, cy - (base_y + 0.12), L.GRID, 1.0)
    L.card(s, 0.75, 5.62, 11.83, 1.08, fill=L.CARD, line=L.LINE)
    L.tbox(s, 1.10, 5.84, 11.2, 0.72, [
        {'runs': [
            {'text': '阶段划分依据：', 'size': 12.5, 'bold': True, 'color': L.ACCENT},
            {'text': '能力单元（回答 → 动作 → 任务 → 目标）与人工介入粒度'
                     '（逐步确认 → 关键节点确认 → 只负责目标与验收）。',
             'size': 12.5, 'color': L.TEXT}], 'line_spacing': 1.3},
        {'text': '注：年份为标志性事件出现区间，代表行业共识节奏，非精确时间点。',
         'size': 10, 'color': L.DIM, 'space_before': 3},
    ])
    L.notes(s, '三个阶段的关键区别是"能力单元"不断变大：回答 → 动作 → 任务 → 目标；'
               '同时人工介入粒度不断变粗：逐步确认 → 关键节点确认 → 只定目标。')

    # ============ 04 自主性分级 ============
    s = L.page(prs)
    L.header(s, 'AUTONOMY LEVELS', '自主性分级：先想清楚你要造哪一级', 4)
    levels = [
        ('L0', '无自主', '纯文本生成，无工具访问', L.DIM, 1.05),
        ('L1', '建议级', '给出方案与步骤，由人执行', L.RGBColor.from_string('4D9AC4'), 1.95),
        ('L2', '单步执行', '调用工具完成原子动作，逐步确认', L.ACCENT, 2.85),
        ('L3', '任务级', '多步自主推进，关键节点人工确认', L.ACCENT2, 3.75),
        ('L4', '长程自治', '跨会话持续目标，自我评估与恢复', L.ACCENT3, 4.65),
    ]
    gy = 5.46
    for i, (lv, name, desc, col, w) in enumerate(levels):
        y = gy - (i + 1) * 0.86
        L.card(s, 0.75, y, w, 0.78, fill=L.CARD, line=L.LINE)
        L.rect(s, 0.75, y, w, 0.055, fill=col)
        L.tbox(s, 0.99, y + 0.11, 0.6, 0.3, [{'text': lv, 'size': 14, 'bold': True, 'color': col}])
        L.tbox(s, 1.61, y + 0.11, 1.1, 0.3, [{'text': name, 'size': 13, 'bold': True, 'color': L.TEXT}])
        L.tbox(s, 2.73, y + 0.14, 3.1, 0.3, [{'text': desc, 'size': 10.5, 'color': L.MUTED}])
    L.vline(s, 0.68, gy - 4.30, 4.34, L.GRID, 1.25)
    L.hline(s, 0.68, gy, 5.75, L.GRID, 1.25)
    L.tbox(s, 0.42, 5.60, 6.0, 0.3,
           [{'text': '自主性 →', 'size': 10.5, 'bold': True, 'color': L.DIM}])
    right = [
        ('当前落地主战场', 'L2 – L3 之间：单步可信、多步可控。多数生产系统止步于此，'
                     '瓶颈不在模型，而在权限模型与失败恢复。', L.ACCENT),
        ('能力跃迁的三个前提', '① 状态可持久化    ② 错误可检测与回滚    ③ 成本可控可预算', L.ACCENT2),
        ('分级的工程意义', '自主性每上一级，权限模型、审计要求与评测复杂度都需同步升级，'
                     '不可"跳级"上线。', L.ACCENT3),
    ]
    for i, (t, d, col) in enumerate(right):
        y = 1.90 + i * 1.54
        L.card(s, 6.98, y, 5.60, 1.34, fill=L.CARD, line=L.LINE)
        L.rect(s, 6.98, y + 0.18, 0.055, 0.98, fill=col)
        L.tbox(s, 7.26, y + 0.20, 5.1, 0.32, [{'text': t, 'size': 14, 'bold': True, 'color': L.TEXT}])
        L.tbox(s, 7.26, y + 0.60, 5.1, 0.68,
               [{'text': d, 'size': 11.5, 'color': L.MUTED, 'line_spacing': 1.32}])
    L.notes(s, '分级不是为了炫技，而是为了对齐期望与风险。建议企业明确自己当前的目标级别：'
               '多数场景 L3 已是可交付上限，L4 仍属前沿探索。')
