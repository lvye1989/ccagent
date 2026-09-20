# -*- coding: utf-8 -*-
"""构建《Agent 发展趋势》演示文稿（10 页 / 16:9）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import deck_lib as L  # noqa: E402
import deck_part1    # noqa: E402
import deck_part2    # noqa: E402
import deck_part3    # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   'Agent发展趋势-10页.pptx')


def main():
    prs = L.new_deck()
    deck_part1.build(prs, L)
    deck_part2.build(prs, L)
    deck_part3.build(prs, L)

    cp = prs.core_properties
    cp.title = 'Agent 发展趋势：从对话式助手到自主执行体'
    cp.subject = '技术栈、生态协议与生产化落地'
    cp.author = 'CCAGENT'
    cp.keywords = 'Agent, MCP, A2A, 上下文工程, 多智能体, 生产化'

    prs.save(OUT)
    print('slides=%d' % len(prs.slides._sldIdLst))
    print('saved=%s' % OUT)


if __name__ == '__main__':
    main()
