"""20.10: шрифт иконок, SVG-иконки, mediaKind по имени, первый кадр кружка. Запуск: python3 tests/media_icons_test.py"""
import io, json, os, re, subprocess, sys
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rd = lambda p: open(os.path.join(R, p), encoding='utf-8').read()
ok = 0
def check(c, m):
    global ok
    if not c: sys.exit('FAIL: ' + m)
    ok += 1

idx, css, sw, med = rd('index.html'), rd('style.css'), rd('sw.js'), rd('media.js')
csp = re.search(r'Content-Security-Policy" content="([^"]+)"', idx).group(1)
check("font-src 'self'" in csp, 'CSP font-src self')
check('googleapis' not in idx + css + csp and 'gstatic' not in idx + css + csp, 'no Google Fonts')
v = re.search(r"url\((fonts/material-symbols-rounded\.woff2\?v=\d+)\)", css).group(1)
check(v in idx and v in sw and os.path.exists(os.path.join(R, v.split('?')[0])), 'font path in css/preload/sw: ' + v)
check('font-display:block' in css, 'font-display block')
check(re.search(r'<script src="icons\.js\?v=\w+"></script>', idx) and idx.index('icons.js') < idx.index('app.js'), 'icons.js before app.js')
check("html:not(.icons-ok) .ms:not(.svgi)" in css and 'color:transparent' in css, 'ligature text hidden until font loads')
ic = rd('icons.js')
for n in ['play_arrow', 'pause', 'mic', 'send', 'download', 'done', 'done_all', 'radio_button_checked', 'radio_button_unchecked']:
    check(re.search(r'\b' + n + r"\s*[:=]", ic), 'svg ' + n)
check('innerHTML' not in ic, 'icons.js no innerHTML')
try:
    from fontTools.ttLib import TTFont
    f = TTFont(os.path.join(R, 'fonts/material-symbols-rounded.woff2')); cm = {g: c for c, g in f.getBestCmap().items()}; names = set()
    for l in f['GSUB'].table.LookupList.Lookup:
        for st in l.SubTable:
            st = getattr(st, 'ExtSubTable', st)
            for a, ls in getattr(st, 'ligatures', {}).items():
                for lg in ls:
                    try: names.add(''.join(chr(cm[g]) for g in [a] + lg.Component))
                    except KeyError: pass
    src = ''.join(rd(p) for p in ['app.js', 'media.js', 'index.html', 'account.js', 'appbanner.js'])
    for n in ['videocam_off', 'settings', 'lock', 'reply', 'more_vert', 'arrow_back', 'radio_button_checked']:
        check(n in names, 'font has ' + n)
except ImportError:
    print('fontTools нет — проверка шрифта пропущена')
# mediaKind (node)
js = med[med.index('function mediaKind'):med.index('window.mediaKind = mediaKind;')]
cases = [({'n': 'voice_1.webm', 'm': 'audio/webm;codecs=opus'}, 'voice'), ({'n': 'voice_1.webm', 'm': ''}, 'voice'),
         ({'n': 'round_1.webm', 'm': 'video/webm;codecs=vp8,opus'}, 'round'), ({'n': 'round_1.webm', 'm': 'audio/webm'}, 'round'),
         ({'n': 'voice_1.ogg', 'm': 'application/ogg'}, 'voice'), ({'n': 'voice_1.opus', 'm': 'application/octet-stream'}, 'voice'),
         ({'n': 'voice_1.m4a', 'm': 'audio/x-m4a'}, 'voice'), ({'n': 'voice_1.mp3', 'm': 'audio/mpeg'}, 'voice'), ({'n': 'VOICE_2.WEBM', 'm': 'video/webm'}, 'voice'),
         ({'n': 'round_1.mp4', 'm': 'video/mp4'}, 'round'), ({'n': 'video_note_1.mp4'}, 'round'), ({'n': 'song.mp3', 'm': 'audio/mpeg'}, None),
         ({'n': 'voice_1.png', 'm': 'image/png'}, None), ({'n': 'roundup.pdf', 'm': 'application/pdf'}, None),
         ({'n': 'voice_1.webm', 'vk': 'round'}, 'round'), ({'n': 'x.mp4', 'vk': 'voice'}, 'voice')]
out = subprocess.run(['node', '-e', js + ';console.log(JSON.stringify(' + json.dumps([c for c, _ in cases]) + '.map(mediaKind)))'], capture_output=True, text=True)
got = json.loads(out.stdout)
for (c, w), g in zip(cases, got): check(g == w, f'mediaKind {c} -> {g}, want {w}')
# кружок: первый кадр
check("v.preload = 'metadata'" in med and 'currentTime = Math.min(0.1' in med and 'v.poster = posterUrl' in med and 'toBlob' in med, 'round poster from first frame')
check('.round-v.wait{background:#2A2F3A}' in css and 'font-size:40px' in css, 'grey circle + 40px play')
check(re.search(r"txt\(ph, 'play_arrow'\)", med), 'play overlay')
check('URL.createObjectURL(new Blob' in med, 'media via blob URL')
print('OK', ok)
