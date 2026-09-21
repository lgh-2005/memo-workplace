# -*- coding: utf-8 -*-
r"""从六级答案解析 PDF 抽取客观题标准答案（v2.7.1）。

数据源：`<year>年<month>月第<set>套真题及答案解析（整卷）.pdf`
输出：`{ 题号(int): 字母 }`，覆盖 1–55 客观题（1–25 听力 / 26–35 选词 / 36–45 长篇匹配 / 46–55 仔细阅读）。

抽取策略（分区锚点 + 区内顺序赋值，不依赖易错的题号回读）：
  · 页面 URL 锚点 `/cet6/sections/listening/...` 或「听力…解析」标题 → listening 区
  · `part3-section-a` → 选词填空（26–35，每项带 `A)` 词形）
  · `part3-section-b` → 长篇匹配（36–45，形如 `【答案】P 段（强锚点）`）
  · `part3-section-c` → 仔细阅读（46–55）
  各区内的 `【答案】X` 按出现顺序对应连续题号。
  长篇匹配段落可到 A–R，故字母范围取 A–S。
"""
import re
import os

DATE_RE = re.compile(r'(\d{4})年(\d{1,2})月第(\d)套')


def _bucket(text):
    if 'part3-section-a' in text:
        return 'bank'
    if 'part3-section-b' in text:
        return 'match'
    if 'part3-section-c' in text:
        return 'reading'
    if '/sections/listening/' in text or 'sections/listening' in text:
        return 'listening'
    if re.search(r'听力(题和解析|真题原文|原文与答案)', text):
        return 'listening'
    return None


def extract_answers(pdf_path):
    """返回 {题号: 字母}。缺失区（共用套）自然为空。"""
    import fitz
    doc = fitz.open(pdf_path)
    order = []   # [(bucket, letter)]
    for i in range(doc.page_count):
        t = doc[i].get_text()
        b = _bucket(t)
        if not b:
            continue
        for m in re.finditer(r'【答案】\s*([A-S])\b', t):
            order.append((b, m.group(1)))
    doc.close()

    out = {}
    groups = {'listening': [], 'bank': [], 'match': [], 'reading': []}
    for b, L in order:
        groups[b].append(L)

    for i, L in enumerate(groups['listening'][:25]):
        out[1 + i] = L
    for i, L in enumerate(groups['bank'][:10]):
        out[26 + i] = L
    for i, L in enumerate(groups['match'][:10]):
        out[36 + i] = L
    for i, L in enumerate(groups['reading'][:10]):
        out[46 + i] = L
    return out


def main():
    ANS_DIR = r'D:\download\cet6\answer'
    files = sorted(f for f in os.listdir(ANS_DIR) if f.endswith('.pdf'))
    bad = 0
    for f in files:
        m = DATE_RE.search(f)
        if not m:
            continue
        a = extract_answers(os.path.join(ANS_DIR, f))
        miss = [n for n in list(range(1, 26)) + list(range(26, 56)) if n not in a]
        status = 'OK ' if not miss else 'MISS'
        if miss:
            bad += 1
        print(f'{status} {m.group(0)}  got={len(a):>2} miss={miss}')
    print('files with missing:', bad)


if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    main()
