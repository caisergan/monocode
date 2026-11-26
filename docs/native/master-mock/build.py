import re,base64,json,pathlib
S=pathlib.Path(__file__).parent
R=S.parents[2]/'crates/monocode-gpui'
src=(R/'src/assets.rs').read_text()
m=dict(re.findall(r'"([a-z0-9-]+)"\s*=>\s*include_bytes!\("\.\./assets/([^"]+)"\)',src))
want="share square-plus search more-horizontal filter git-pull-request continued cursor-magic zap clock sliders settings chevron-down chevron-right chevron-left x plus mono-arrow-up check check-circle circle-x alert-circle loader-03 square-lock eye file-diff git-branch git-commit git-merge external-link refresh-cw play queue-pause square queue-steer queue-list archive pin pencil-edit inbox note bell-off globe sidebar sidebar-right terminal message-square list-bullet gauge trash star undo shield-alert arrow-left rotate-ccw dashboard circle-dashed-hi circle-dot folder chatting response-handoff gauge file-script".split()
css=[];miss=[]
def uri(t): return 'data:image/svg+xml;base64,'+base64.b64encode(t.encode()).decode()
for n in want:
    if n not in m: miss.append(n); continue
    css.append(f'.i-{n}{{--i:url("{uri((R/"assets"/m[n]).read_text())}")}}')
hub='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.75"><circle cx="12" cy="13" r="2.6" fill="#fff" stroke="none"/><path d="M12 10.4V6.5M9.7 14.4l-3.2 1.9M14.3 14.4l3.2 1.9"/><circle cx="12" cy="4" r="2.25"/><circle cx="4.5" cy="17.6" r="2.25"/><circle cx="19.5" cy="17.6" r="2.25"/></svg>'
css.append(f'.i-hub{{--i:url("{uri(hub)}")}}')
off=hub.replace('<circle cx="12" cy="13"','<path d="M4 3l16 18"/><circle cx="12" cy="13"')
css.append(f'.i-hub-off{{--i:url("{uri(off)}")}}')
css.append(f'.i-circle-alert{{--i:url("{uri((R/"assets"/m.get("circle-alert",m["alert-circle"])).read_text())}")}}')
mk={}
for n in ['claude','codex','pi','hermes','opencode','omp']:
    t=(R/'assets'/f'{n}.svg').read_text()
    mk[n]=uri(t.replace('currentColor','#ebebeb'))
sp={x['name']:x['rest'] for x in json.loads((R/'src/monos/sprites.json').read_text())}
t=(S/'tpl.html').read_text()
js=(S/'screens.js').read_text()
t=t.replace('/*ICONS*/','\n'.join(css)).replace('/*DATA*/','const MK='+json.dumps(mk)+',SP='+json.dumps(sp)+';').replace('/*SCREENS*/',js)
(S/'index.html').write_text(t)
print('missing',miss,len(t))
