#!/usr/bin/env python3
"""Make a WebVTT caption file from a film timeline (the agents-film format).

  python3 library/tools/timeline_to_vtt.py <timeline.json> [words.js] > captions.en.vtt

timeline.json: {"lines": [{"id", "who", "text", "t0", "dur"}, ...]} -- one spoken line each, t0 and dur
in seconds from the start of the film. words.js (optional): window.WORDS = {id: [[word, t], ...]}, word
times from the line's start, used to place the breaks inside a long line; without it the time is
shared out by characters. Long lines are cut into cues of at most two rows of ~42 characters, at a
sentence or comma where possible.
"""
import json
import re
import sys

MAX = 84
ROW = 42
NAMES = {'allocate': 'AlloCate', 'matrix': 'Matrix'}


def ts(t):
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return '%02d:%02d:%02d.%03d' % (h, m, s, ms)


def chunks(tokens):
    """Split a token list into runs of <= MAX chars, preferring breaks after . ? ! then , ; :"""
    out, start = [], 0
    while start < len(tokens):
        n, best, best_score = 0, None, -1
        for i in range(start, len(tokens)):
            n += len(tokens[i]) + (1 if i > start else 0)
            if n > MAX and i > start:
                break
            end_tok = tokens[i]
            score = 3 if re.search(r'[.?!]["\')]*$', end_tok) else 2 if re.search(r'[,;:]$', end_tok) else 1
            if i == len(tokens) - 1:
                score = 4
            if score >= best_score:
                best, best_score = i, score
        out.append((start, best + 1))
        start = best + 1
    return out


def two_rows(text):
    if len(text) <= ROW:
        return text
    words, best, best_d = text.split(' '), None, 1e9
    for i in range(1, len(words)):
        a = ' '.join(words[:i])
        d = abs(len(a) - len(text) / 2.0)
        if d < best_d:
            best, best_d = i, d
    return ' '.join(words[:best]) + '\n' + ' '.join(words[best:])


def main():
    tl = json.load(open(sys.argv[1], encoding='utf-8'))
    words = {}
    if len(sys.argv) > 2:
        src = open(sys.argv[2], encoding='utf-8').read()
        words = json.loads(src[src.index('{'):src.rindex('}') + 1])
    out = ['WEBVTT', '']
    lines = sorted(tl['lines'], key=lambda l: l['t0'])
    n = 0
    for li, l in enumerate(lines):
        toks = l['text'].split()
        t0, t1 = float(l['t0']), float(l['t0']) + float(l['dur'])
        nxt = lines[li + 1]['t0'] if li + 1 < len(lines) else t1 + 1
        ws = words.get(l['id']) or []

        def at(k):  # start time of token k
            if k <= 0:
                return t0
            if k >= len(toks):
                return t1
            if ws:
                j = min(len(ws) - 1, int(round(k * len(ws) / float(len(toks)))))
                return t0 + float(ws[j][1])
            done = sum(len(x) + 1 for x in toks[:k])
            return t0 + (t1 - t0) * done / float(sum(len(x) + 1 for x in toks))

        who = NAMES.get(l.get('who'), l.get('who') or '')
        for a, b in chunks(toks):
            s = at(a) - (0.1 if a == 0 else 0)
            e = at(b) if b < len(toks) else min(t1 + 0.4, nxt - 0.05)
            n += 1
            text = two_rows(' '.join(toks[a:b]))
            out += [str(n), '%s --> %s' % (ts(s), ts(max(e, s + 0.5))),
                    ('<v %s>' % who if who else '') + text, '']
    sys.stdout.write('\n'.join(out))


if __name__ == '__main__':
    main()
