# Boat Recorder changelog

## v1.1 · 28 Nov 2026 (overnight reliability pass)

The focus was reliability for Sunday 29 Nov. No settings keys were renamed: `boat.settings`, `oarlockCal:<serial>` and `oarlockZero:<serial>` work as before. One field was added inside `boat.settings` (`lastGates`) and there is one new key (`boat.errors`). Nothing in `oarlock/` or the ErgCurve files was touched.

### Bugs fixed
- **Drill stroke count was one stroke behind.** A stroke was only counted when the *next* catch began. So the number the cox saw lagged by a stroke, and the last stroke of a drill was usually lost when you tapped Stop. Strokes now count at the finish, and the rule is unchanged: only strokes whose catch comes after the tap count. Rate is worked out the same way as before.
- **Changing boat size could put several gates on one seat.** For example, going from an eight with gates on 3–6 to a four put three gates on stroke seat. Gates now move to free seats, and you can't choose a boat smaller than the number of gates.
- **Bluetooth reconnects stopped after 5 tries**, and a gate that wasn't in range when the app opened was never tried again. Now (see below) it keeps trying for as long as a session is recording.
- **Connecting 4 gates at once.** When the app opened, it connected to every gate at the same time, which Android's Bluetooth handles badly. Connections now happen one at a time, with time limits (10 s to connect, 15 s for setup), so a gate that is switched off can't hang the others.
- **Every gate the phone had ever paired with was brought back on launch**, including Oarlock Live's gates, and they took seats. Now only the gates from the unfinished session, or from the last session, are restored.
- **Data could be lost or duplicated in storage.** Each 2 s save was two separate writes, so a crash between them could make a resumed session reuse a sequence number. Saves are now a single transaction, they run one at a time and in order, and a failed save goes back in the queue instead of being dropped. Resume reads the highest sequence number actually stored.
- **A storage write that aborted (for example, a full disk) could hang saving forever.** It now fails, logs the error and retries.
- **A double tap on Start or Resume could start two sessions.** It can't any more.
- **A session left a little data in memory** that leaked into the next session. It doesn't any more.
- **GPS distance started from wherever the phone was last fixed before Start**, and it also counted drift while sitting at the pontoon. Distance now starts fresh at Start and only counts when the boat is moving at 0.5 m/s or more. "GPS off" now shows if location permission is denied.
- **The Android back gesture on the cox screen closed the app mid-session.** It now stays on the cox screen and shows "Still recording. Tap End session to stop."
- **A drill that was running when the app died stayed open forever.** On Resume it is closed as `drill_interrupted`. If the app was killed without warning, the gap is now marked on the timeline using `gapFrom` on the `resume` event.
- **Offline start-up:** if the network doesn't answer within 3 s (weak Wi-Fi at the shed), the cached app opens instead of waiting. Old `boat-*` caches are cleared, and Oarlock Live's caches are left alone.

### New
- **Live gates on the Ready screen:** one row per gate showing seat, rower, angle (°), force and a moving bar. Wiggle each oar and check that the right seat moves before you start.
- **Reconnect forever while recording.** Every 3 s the app retries any gate that's down, backing off to every 10 s for a gate that stays off. If a gate says it is connected but sends nothing for 6 s, the start command is sent again. `connect` events (with attempt count and connect time), `disconnect` and `restart_stream` events are all recorded.
- **Errors are captured.** Uncaught errors, unhandled promise rejections, failed connects and failed saves are logged as session events (`type: "error"`) and kept (the last 20) for diagnostics.
- **Copy diagnostics button on Home:** copies version, gates (seat, side, connected, last data, battery, calibration, drops), GPS, storage used and the last 20 errors. Paste it into a chat.
- **Remove button on each gate** on the Connect screen.
- Gates added mid-session are added to the session's gate list, and the export includes `exportedBy` and `chunks`.

### Test
`tests/boat.test.js` (Node + jsdom + fake-indexeddb, plus a fake Web Bluetooth with 4 gates) runs 86 checks: the drill counter, a full session on an eight (seats 3–6, tandem bow side on 5 and 4) with a drill, a cancelled drill, a rower change, end and export, a boat-size change, settings surviving a reload, Bluetooth restore/reconnect/stalled stream, and Resume after the app is killed. The run instructions are at the top of the file. Result: 86 passed, 0 failed. A smoke run in real headless Chromium also showed no errors.

### Please check on the phone (only a real Samsung with real gates can confirm these)
1. **Update:** open the app on Wi-Fi, tap *Update now*, and check that Home says **Version v1.1 · 28 Nov**. If it still says v1.0, close the app fully and open it again.
2. **Connect all 4 gates** and time it. Then use *Copy diagnostics* and check each gate shows "connected" with recent "last data".
3. **Ready screen live rows:** move each oar in turn and check the matching seat's angle changes and force reacts when you push on the pin.
4. **Drop-out test:** during a short test session, switch one gate off for 30 s or more, then on again. It should reconnect by itself within about 15 s, and the others should keep recording.
5. **Back gesture on the cox screen:** it should stay put and show a message. Also try two quick Backs without touching the screen. Chrome may let that through and close the app. If it does, reopen the app and tap Resume (the data is safe).
6. **Drill count:** do a 10-stroke drill and check the number on screen matches the strokes taken.
7. **Kill test:** swipe the app away mid-session, reopen it, tap Resume, end the session and export. The timeline should show a striped gap.
8. **Restored gates after a relaunch:** only the gates from the last session should come back.
9. **Restart of a silent gate:** if the cox banner says a gate is "not sending" while it's connected, the app re-sends the start command every 6 s. Watch whether that brings it back.
10. **GPS distance** sitting still at the pontoon should stay near 0, and split should appear within a few strokes of moving off.
