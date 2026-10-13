#!/usr/bin/env python3
"""v3.5.0：Piper 神经语音常驻工作进程（服务端句子朗读）。

协议：从 stdin 逐行读取 JSON 请求，向 stdout 逐行返回 JSON 结果。
  {"id": "<token>", "text": "...", "voice": "en_US"|"en_GB", "out": "/abs/path.wav"}
  -> {"id": "<token>", "ok": true}
  -> {"id": "<token>", "ok": false, "error": "..."}

模型路径通过命令行传入：
  --en_US /path/en_US.onnx [--en_GB /path/en_GB.onnx]

模型按需懒加载，最多同时驻留 1 个（显存档位在启动参数中声明），以控制内存。
"""
import sys
import json
import argparse
import wave


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument('--en_US', dest='en_US', default='')
    ap.add_argument('--en_GB', dest='en_GB', default='')
    ap.add_argument('--max-voices', dest='max_voices', type=int, default=1)
    return ap.parse_args()


def main():
    args = parse_args()
    models = {}
    if args.en_US:
        models['en_US'] = args.en_US
    if args.en_GB:
        models['en_GB'] = args.en_GB

    # 延迟导入，避免无 Piper 环境时也占用启动时间
    from piper import PiperVoice

    loaded = {}
    order = []
    max_voices = max(1, args.max_voices)

    # 就绪握手：服务端据此判定进程可用（否则会一直等待 stdout 而阻塞）
    sys.stdout.write(json.dumps({'ready': True}) + '\n')
    sys.stdout.flush()

    def load(voice_key):
        if voice_key in loaded:
            return loaded[voice_key]
        path = models.get(voice_key)
        if not path:
            raise RuntimeError('未配置该语音模型: ' + voice_key)
        while len(order) >= max_voices:
            old = order.pop(0)
            loaded.pop(old, None)
        voice = PiperVoice.load(path)
        loaded[voice_key] = voice
        order.append(voice_key)
        return voice

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            voice_key = req.get('voice') or 'en_US'
            text = str(req.get('text') or '').strip()
            out = req.get('out')
            if not text or not out:
                raise ValueError('缺少 text 或 out 参数')
            voice = load(voice_key)
            with wave.open(out, 'wb') as wf:
                voice.synthesize_wav(text, wf)
            sys.stdout.write(json.dumps({'id': req.get('id'), 'ok': True}) + '\n')
        except Exception as exc:  # noqa: BLE001 - 逐请求隔离，不能因单条失败退出
            sys.stdout.write(json.dumps({
                'id': (req or {}).get('id'),
                'ok': False,
                'error': str(exc),
            }) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
