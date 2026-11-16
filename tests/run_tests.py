"""
ErgCurve automated checks – run before every release.

    python3 tests/run_tests.py [path/to/index.html]

Drives the page in headless Chrome using Demo mode (simulated PM5 data) and
checks every behaviour we've built or fixed so far. Each check names the
version where the behaviour was added or the bug was fixed, so a failure
points at what has regressed. Real-erg checks live in tests.html.
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

PAGE = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'index.html'))
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
results = []

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (f'  [{detail}]' if detail and not ok else ''))

async def fresh(b, errs, viewport=(390, 844)):
    ctx = await b.new_context(viewport={'width': viewport[0], 'height': viewport[1]})
    pg = await ctx.new_page()
    pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
    pg.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' else None)
    await pg.goto('file://' + PAGE)
    await pg.wait_for_timeout(400)
    return pg

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
        errs = []

        print('\n[Page basics]')
        pg = await fresh(b, errs)
        ver = await pg.inner_text('#appVersion')
        check('Version shown at bottom as a Test version (v5.4)', ver.startswith('ErgCurve Test v'), ver)
        check('Security policy present (v5.1)', await pg.evaluate("!!document.querySelector('meta[http-equiv=Content-Security-Policy]')"))
        check('No external scripts loaded (v5.1)', await pg.evaluate("[...document.scripts].every(s => !s.src)"))

        print('\n[Single erg – recording]')
        await pg.evaluate('startDemo(true)'); await pg.wait_for_timeout(800)
        check('Warm-up strokes not saved before Start recording (v4.3)', await pg.evaluate('!session && preview.length > 0'))
        h1 = await pg.evaluate('document.body.scrollHeight'); await pg.wait_for_timeout(800)
        h2 = await pg.evaluate('document.body.scrollHeight')
        check('Live page height stays fixed while redrawing (v1 canvas bug)', h1 == h2 and h2 < 4000, f'{h1}->{h2}')
        await pg.evaluate('stopDemo()')
        await pg.evaluate('startDemo(false)'); await pg.wait_for_timeout(6500)
        await pg.click('#btnRecord'); await pg.wait_for_timeout(250)
        check('Time/metres reset to 0:00 / 0 on Start recording (v4.3)',
              (await pg.inner_text('#tTime')) == '0:00' and (await pg.inner_text('#tDist')) == '0',
              f"{await pg.inner_text('#tTime')} {await pg.inner_text('#tDist')}")
        chips = [await e.inner_text() for e in await pg.query_selector_all('#rowerChips button')]
        check('Name picker shows your name first (v5.0)', chips[:1] == ['Harry'], str(chips))
        await pg.fill('#rowerInput', 'Testy McTest'); await pg.click('#rowerOk')
        check('Rower name applied to recording (v4.4)', 'Testy McTest' in await pg.inner_text('#statusText'))
        t_a = await pg.inner_text('#tTime'); await pg.wait_for_timeout(1500); t_b = await pg.inner_text('#tTime')
        check('Clock ticks between strokes (v4.2)', t_a != t_b, f'{t_a} -> {t_b}')
        await pg.evaluate('stopDemo()'); await pg.wait_for_timeout(5000)
        t_c = await pg.inner_text('#tTime'); await pg.wait_for_timeout(1200)
        check('Clock freezes when strokes stop (v4.2)', t_c == await pg.inner_text('#tTime'))
        await pg.evaluate('startDemo(true)'); await pg.wait_for_timeout(1500); await pg.evaluate('stopDemo()')
        n = await pg.evaluate('session.strokes.length'); nc = await pg.evaluate('session.strokes.filter(s => s.curve).length')
        check('Strokes recorded with force curves', n > 20 and nc >= n - 1, f'{nc}/{n}')
        await pg.evaluate('finishSession(false)'); await pg.wait_for_timeout(500)
        names = await pg.evaluate("(async () => (await DB.all()).map(s => s.rower))()")
        check('Session saved with rower name', 'Testy McTest' in names, str(names))
        check('Name saved to roster for next time (v5.0)', 'Testy McTest' in await pg.evaluate('getRoster()'))

        print('\n[Single erg – edge cases]')
        await pg.evaluate('startDemo(false)'); await pg.click('#btnRecord'); await pg.click('#rowerSkip')
        await pg.evaluate('stopDemo(); finishSession(false)'); await pg.wait_for_timeout(500)
        check('Sessions with <3 strokes are discarded', await pg.evaluate('(async () => (await DB.all()).length)()') == 1)
        r = await pg.evaluate('''(async () => {
          live.forceSource = 'ble'; startRecording(); LiveDraw.running = true;
          const full = [10,40,80,120,150,170,160,130,90,50,20,0];
          const s = new Array(20).fill(0); s[6] = 140; s[18] = 1;
          LiveDraw.driveStart = performance.now(); LiveDraw.updates = 3; LiveDraw.buf = full.slice(); LiveDraw.lastPt = performance.now();
          onStrokeRecord(Parse.stroke(new DataView(new Uint8Array(s).buffer)));
          const tail = [130,90,50,20,0], pk = [(1 << 4) | tail.length, 0]; tail.forEach(x => pk.push(x & 255, x >> 8));
          onForceCurvePacket(new DataView(new Uint8Array(pk).buffer));
          LiveDraw.finish(); LiveDraw.running = false;
          const st = session.strokes[0]; const out = [st.curve.length, st.curveSrc];
          session = null; live.strokes = preview; return out; })()''')
        check('Live draw saves full curve, not the cut-off PM5 one (v4.1 sloping-curve bug)', r == [12, 'live'], str(r))
        await pg.close()

        print('\n[Ideal curve]')
        pg = await fresh(b, errs)
        await pg.evaluate('startDemo(true)'); await pg.wait_for_timeout(600); await pg.evaluate('stopDemo()')
        has = await pg.evaluate("(() => { const rs = live.strokes.filter(s => s.curve).map(s => resample(s.curve).map(fConv)); const id = idealFor(rs); return !!id && id.y.length === 50; })()")
        check('Ideal curve drawn on live chart by default (v5.2)', has)
        sh = await pg.evaluate('idealShape()')
        pk = sh.index(max(sh))
        check('Default ideal peaks ~40% of drive, starts and ends near zero (v5.2)', 17 <= pk <= 22 and sh[0] < 0.05 and sh[-1] < 0.05, str(pk))
        await pg.click('#idealLive')
        check('Live toggle turns the ideal off (v5.2)', await pg.evaluate('ideal.on === false && idealFor([[1,2,3]]) === null'))
        await pg.click('#tabMore'); await pg.wait_for_timeout(200)
        check('Settings toggle stays in sync (v5.2)', not await pg.is_checked('#idealSettings'))
        await pg.click('#idealSettings'); await pg.fill('#iPos', '30'); await pg.dispatch_event('#iPos', 'input')
        sh2 = await pg.evaluate('idealShape()')
        check('Peak position slider moves the peak (v5.2)', sh2.index(max(sh2)) < pk)
        await pg.reload(); await pg.wait_for_timeout(300)
        check('Ideal settings remembered after reload (v5.2)', await pg.evaluate('ideal.on && ideal.pos === 30'))
        await pg.close()

        print('\n[Session analysis & export]')
        pg = await fresh(b, errs)
        await pg.evaluate('startDemo(true)'); await pg.click('#btnRecord'); await pg.click('#rowerSkip')
        await pg.wait_for_timeout(1500); await pg.evaluate('stopDemo(); finishSession(false)'); await pg.wait_for_timeout(400)
        await pg.click('#tabSessions'); await pg.wait_for_timeout(300); await pg.click('#sessList .sess'); await pg.wait_for_timeout(400)
        total = await pg.evaluate('detail.s.strokes.length')
        await pg.fill('#fFrom', '5'); await pg.fill('#fTo', '14'); await pg.wait_for_timeout(200)
        check('Stroke range filter (v4.3)', (await pg.inner_text('#fInfo')).startswith('10 of'), await pg.inner_text('#fInfo'))
        await pg.fill('#fFrom', ''); await pg.fill('#fTo', ''); await pg.fill('#fLen', '9'); await pg.wait_for_timeout(200)
        check('Min drive length filter (v4.3)', (await pg.inner_text('#fInfo')).startswith('0 of'))
        await pg.fill('#fLen', '')
        csv = await pg.evaluate('toCsv(detail.s)')
        check('CSV export has header + one row per stroke', csv.split('\n')[0].startswith('stroke,') and len(csv.split('\n')) == total + 1)
        js = await pg.evaluate('(async () => JSON.stringify({sessions: await DB.all()}))()')
        await pg.evaluate('(async () => { for (const s of await DB.all()) await DB.del(s.id); })()')
        await pg.click('#tabMore'); await pg.fill('#pasteImport', js); await pg.click('#btnPasteImport'); await pg.wait_for_timeout(400)
        check('Paste-import restores a copied backup (v3)', await pg.evaluate('(async () => (await DB.all()).length)()') == 1)
        evil = {'id': 'sx', 'start': 1, 'end': 2, 'rower': '<img src=x onerror="window.__xss=1">', 'name': '<b>hi</b>', 'strokes': [{'n': 1}, {'n': 2}, {'n': 3}]}
        await pg.fill('#pasteImport', json.dumps(evil)); await pg.click('#btnPasteImport'); await pg.wait_for_timeout(300)
        await pg.click('#tabSessions'); await pg.wait_for_timeout(500)
        check('Imported names shown as text, never run as code (v5.1 security)',
              not await pg.evaluate('!!window.__xss') and await pg.evaluate("[...document.querySelectorAll('#sessList img')].length == 0"))
        await pg.close()

        print('\n[Multi erg]')
        pg = await fresh(b, errs)
        await pg.click('#modeSeg button[data-m=multi]')
        await pg.evaluate('window.__fastDemo = true')
        for _ in range(3): await pg.click('#mDemo')
        await pg.wait_for_timeout(1500)
        check('Three demo ergs connected (v5.0)', await pg.evaluate('liveErgs().length') == 3)
        await pg.click('#mRecord'); await pg.wait_for_timeout(2500)
        n_lead = await pg.evaluate("document.querySelectorAll('#mList .leader').length")
        check('Exactly one rower highlighted as leader (v5.3)', n_lead == 1, str(n_lead))
        check('Leader is the highest 3-stroke-average watts (v5.3)', await pg.evaluate(
            "(() => { const L = currentLeader(); return liveErgs().every(s => s === L || avg3(s).watts <= avg3(L).watts); })()"))
        check('3-stroke average shown for each rower (v5.3)', await pg.evaluate("document.querySelectorAll('#mList .avg3').length") == 3)
        await pg.click('#leaderToggle'); await pg.wait_for_timeout(300)
        check('Leader highlight can be switched off (v5.3)', await pg.evaluate("document.querySelectorAll('#mList .leader').length") == 0)
        await pg.click('#leaderToggle')
        check('Start recording all records every erg', await pg.evaluate('ergs.filter(s => s.session && s.session.strokes.length > 1).length') == 3)
        for v in ['Gallery', 'Single']:
            await pg.click('#btnView'); await pg.wait_for_timeout(400)
            check(f'{v} view shows (v5.0)', v in await pg.inner_text('#btnView') and not await pg.evaluate(f"$('m{v}').classList.contains('hidden')"))
        a = await pg.inner_text('#mSingle .nm'); await pg.click('#mSingle .next'); await pg.wait_for_timeout(200)
        check('Single view moves to next rower', a != await pg.inner_text('#mSingle .nm'))
        await pg.click('#modeSeg button[data-m=single]'); await pg.wait_for_timeout(200)
        check('Mode switch blocked while ergs connected', 'Disconnect' in await pg.inner_text('#toast'))
        await pg.click('#btnView'); await pg.click('#mFinish'); await pg.click('#modalYes'); await pg.wait_for_timeout(800)
        check('Each rower saved as their own session', await pg.evaluate('(async () => (await DB.all()).length)()') == 3)
        await pg.close()

        print('\n[Workouts, targets & traffic lights]')
        pg = await fresh(b, errs)
        await pg.evaluate('''setWorkouts([{ id: 'wt', name: 'Step test', type: 'stepped', rate: 20,
            steps: [{ kind: 'time', amount: 30, rate: 20 }, { kind: 'time', amount: 30, rate: 22 }, { kind: 'dist', amount: 100, rate: 24 }] }]);
            setActiveWorkout('wt');''')
        check('Workout picker on Live tab shows the active workout (v5.4)', await pg.evaluate("document.querySelector('.wSelect').value") == 'wt')
        await pg.click('#tabWorkouts'); await pg.click('#wNew'); await pg.fill('#wName', 'Steady 20')
        await pg.select_option('#wType', 'steady'); await pg.fill('#wRate', '20'); await pg.click('#wSave'); await pg.wait_for_timeout(200)
        names = await pg.evaluate('getWorkouts().map(w => w.name)')
        check('New workout saved from the Workouts tab (v5.4)', 'Steady 20' in names, str(names))
        check('Saving a second workout keeps the active one (v5.4)', await pg.evaluate("activeWorkoutId") == 'wt')
        await pg.click('#tabLive')
        await pg.evaluate('startDemo(true)'); await pg.click('#btnRecord'); await pg.click('#rowerSkip')
        await pg.wait_for_timeout(250)
        tl = await pg.evaluate("(() => { const t = document.getElementById('tRate'); return t ? [...t.parentElement.classList].join(' ') : 'none'; })()")
        check('Rate tile shows a traffic-light colour against the target (v5.4)', 'tl-' in tl, tl)
        check('Workout strip shows the current step and target (v5.4)', 'Step' in await pg.inner_text('#wStrip .small'))
        await pg.wait_for_timeout(1500); await pg.evaluate('stopDemo()')
        seq = await pg.evaluate('''(() => { const out = []; session.strokes.forEach(x => { if (out[out.length - 1] !== (x.target ?? 'done')) out.push(x.target ?? 'done'); }); return out; })()''')
        check('Each stroke saves its target; steps go 20 → 22 → 24 → done (v5.4)', seq == [20, 22, 24, 'done'], str(seq))
        check('Strip says the workout is complete at the end (v5.4)', 'complete' in await pg.inner_text('#wStrip .small'))
        await pg.evaluate('finishSession(false)'); await pg.wait_for_timeout(400)
        await pg.click('#tabSessions'); await pg.wait_for_timeout(300); await pg.click('#sessList .sess'); await pg.wait_for_timeout(400)
        check('Saved session shows target vs actual for each step (v5.4)',
              not await pg.evaluate("$('dWorkoutCard').classList.contains('hidden')") and await pg.evaluate("$('dWorkoutTable').rows.length") == 4)
        await pg.click('#segMetric button:has-text("Rate")'); await pg.wait_for_timeout(200)
        check('Rate chart draws the grey target line (v5.4)', await pg.evaluate("detail.metric === 'rate' && detail.s.strokes.some(x => x.target != null)"))
        await pg.click('#segMetric button:has-text("Recovery time")'); await pg.wait_for_timeout(100)
        await pg.click('#segMetric button:has-text("Rec ÷ drive")'); await pg.wait_for_timeout(100)
        check('Recovery time and recovery ÷ drive charts available (v5.4)', 'Recovery ÷ drive ratio' in await pg.inner_text('#dSummary'))
        await pg.click('#tabMore'); await pg.wait_for_timeout(200)
        await pg.click('#disp_single label:has-text("Drive length") input'); await pg.click('#disp_single label:has-text("Recovery time") input')
        await pg.click('#tabLive'); await pg.wait_for_timeout(200)
        check('Display settings hide and add tiles on the Live screen (v5.4)', await pg.evaluate("!$('tDrive') && !!$('tRec')"))
        await pg.reload(); await pg.wait_for_timeout(300)
        check('Display settings remembered after reload (v5.4)', await pg.evaluate("!$('tDrive') && !!$('tRec')"))
        await pg.close()

        pg = await fresh(b, errs)
        await pg.evaluate('''setWorkouts([{ id: 'ws', name: 'Steady 20', type: 'steady', rate: 20, steps: [] }]); setActiveWorkout('ws');''')
        await pg.click('#modeSeg button[data-m=multi]'); await pg.evaluate('window.__fastDemo = true')
        await pg.click('#mDemo'); await pg.click('#mDemo'); await pg.wait_for_timeout(600)
        await pg.click('#mRecord'); await pg.wait_for_timeout(1200)
        pills = await pg.evaluate("document.querySelectorAll('#mList .tgt .pill').length")
        check('Multi cards show the target-rate traffic-light pill (v5.4)', pills == 2, str(pills))
        check('Multi sessions save the target per stroke (v5.4)', await pg.evaluate("ergs.filter(s => s.session && s.session.strokes.some(x => x.target === 20)).length") == 2)
        check('Workout picker locked while recording (v5.4)', await pg.evaluate("[...document.querySelectorAll('.wSelect')].every(s => s.disabled)"))
        await pg.close()

        print('\n[Errors]')
        bad = [e for e in errs if 'Bluetooth' not in e]
        check('No script errors or security-policy violations during tests', not bad, '; '.join(bad[:3]))
        await b.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f" – {len(failed)} FAILED" if failed else ' – all good'))
    sys.exit(1 if failed else 0)

asyncio.run(main())
