# Scales feedback

Practise the singing exercises from `../python` (the MIDI files in `python_final`) with the notes falling onto a piano keyboard, Synthesia style. The microphone tells you whether you hit each note. It never listens during the reference chords.

The app has no list of known exercises. It reads each MIDI file from scratch: where the reference chords are, which line you sing, how many voices there are and what key each round is in. A new exercise from the generator works as soon as the file exists.

## Opening it

Open **https://yonabenreuven2.github.io/scales-feedback/** (to publish it there, see *GitHub Pages* at the end of this file).

On an https address Chrome remembers what you allowed: the mic, the piano's audio, the piano (MIDI) and the exercise folder. So everything you used last time connects by itself when the page opens. When Chrome asks, choose *Allow while visiting the site* (or *Allow on every visit* for the folder). The first time, it asks once for the mic: choose your mic in its box. After that the app can see every input by name, so it opens *Line (P-Series)* for the piano filter by itself.

Opening `index.html` straight from the disk works too, but Chrome remembers nothing there and hides the inputs' names. It asks for every input separately, every time: once for the mic, then a second time for the piano's audio, where you choose *Line (P-Series)* in its box. The folder needs a click too. The disk copy and the Pages site keep separate settings, so link the folder and import the samples once in each.

Use Chrome or Edge. Firefox and Safari have no Web MIDI, so they can't play the P-225.

**Install it as an app**, like the ear trainer and the practice log. On the Pages site, in Chrome, press the install icon at the right of the address bar (or the menu, *Cast, save and share*, *Install page as app*). On Android, use the menu's *Install app*. It then opens in its own window, also without a connection. It keeps the same settings, permissions, calibration and samples as the site in a tab, since it is the same site. The filter lab opens inside it.

**Updates** need nothing from you. Every time the app opens, it checks the server for newer files and uses them, so there's no need for Ctrl+Shift+R. Without a connection it opens the copy it kept. If a new version is pushed while the app is open, a bar at the bottom says so: **Reload** switches to it (it stops an exercise in progress), **Later** keeps the bar away until the next change.

## First time

1. **Exercises:** press **Link exercise folder** and pick `python_final`. Every `.mid` in it shows up, and new ones appear the next time you open the app or the list. You can also add files, or drop them on the page.
2. **Sound** (Settings): pick what plays the notes, and what there is to set for it shows under it.
   - **Piano** plays the P-225 over USB MIDI. Connect the USB cable and choose **Piano**; the browser asks once for MIDI access. Under it: the MIDI output and channel, **the piano's USB audio** (for singing without headphones, below), and the sustain pedal as play and pause.
   - **Samples** plays a zip of recordings, like `p225-samples.zip`. The zip is stored in this browser only. It is never uploaded and never part of the site.
   - **Built-in** is a simple synth, for when nothing else is available.
3. **Touch:** the files are written at full velocity. The two touch sliders set how hard the chords and your notes are played instead (keys you click on the screen play at your notes' touch). The metronome's volume is there too.
4. **Microphone:** press **M**, or the mic button. The first time, the browser asks to use the microphone and lets you choose one in its box. If that box is left on the piano (Windows often makes *Line (P-Series)* its default input), the app opens your real mic instead. Settings shows which mic it's listening with, and a bar under it shows what it hears. Picking another mic in the list switches to it straight away. Avoid a Bluetooth headset mic: it switches the headphones to call quality.

## Practising

- **Play my notes / Chord only:** with *Chord only* the piano plays just the reference chords. Your notes are drawn dashed and keep their timing as if they were played.
- **Voices:** in exercises with several voices, choose the one you sing and the others keep playing. *Any* plays them all and scores whichever voice you sing.
- **Metronome** (the button next to the tempo, or K): a click on every beat of the exercise at the tempo you set, the first beat of each bar a little higher, counting in before each key. Faint lines across the falling notes show the beats, the bar lines stronger. The click is a short burst of noise with no pitch, so it is never taken for a note you sang, filter or no filter: a moment it drowns out is just not judged.
- **Where you sing:** a beam rises from the key you're singing. While a note is judged it is coloured by how close you are, with the cents; between notes, while paused, or with no exercise open it is plain, so you can always see where your voice is. It never shows the piano's own sound as you.
- **The box** (top right) shows the note to sing, what you sing, how many cents off you are, and the last note's verdict. Under the keyboard, your pitch trace is drawn against the notes you just sang. In Settings, *The box* can move out of the notes' way instead: once per key, to the left when the key's notes are under it on the right.
- **Not showing how you're doing** (H, or Settings, *While I sing, show*): *only where I'm singing* keeps the beam (plain) and your pitch trace but hides the box, the colours and the per-key verdicts; *nothing until the end* hides the beam too. The results are all there afterwards.
- **The keyboard:** drag its top edge to make the keys taller, its bottom edge to make the strip under it bigger or smaller (double-click an edge, or *Reset the sizes*, for the automatic sizes). Click or drag along the keys to play them on whatever plays the notes. In Settings, *The keyboard shows* the whole exercise (with keys to spare either side), all 88 keys, or a set number of white keys. Zoomed in (+ and −, Ctrl + wheel or a pinch), it scrolls by itself so what's about to be played, and your voice, stay in view; drag the notes sideways or use the wheel to look around, and the strip at the bottom shows where you are. 0 shows the whole exercise again.
- **Verdicts:** within the tolerance (Settings, 35 cents by default) is a hit. Within twice the tolerance is close. Anything further is off, and too little voice counts as not heard.
- **Grace at each note's edges** (Settings, 120 ms by default): the start and end of each note aren't judged, while your voice moves from one note to the next. It's at most a third of the note at each end, so short notes are still judged.
- **Results** (R), *This run*: how many notes you hit, missed (off or not heard), your tuning on average (flat or sharp), how long you take to settle on a note, how steady you hold it; the few things that stand out, in words (the scale degree and direction you miss most, a register that goes flat, notes not heard, slow settling, against your last runs); then every scale degree split by the way you moved to it (going up, going down, repeated or first), every note, and every key. **Practise the weak keys** loops only the keys under 70%.
- **Results**, *Over time*: your score, tuning and settling run by run (point at a run for its numbers), the scale degrees you've missed most over your runs, what changed between your earlier and later runs, and every run. **Export all results** saves a CSV.
- **Practice settings:** *Skip keys outside my range*, *Shuffle*, *Repeat key*, a lead-in before the first chord, and solfège (movable do, la-based minor), note names or no labels.

| Key | Does |
| --- | --- |
| Space | Play or pause (the piano's sustain pedal can do this too, see Settings) |
| ← → | Previous / next key |
| ↑ ↓ | Tempo ±5 (Shift: ±1) |
| Home | Back to the first key |
| G | Play my notes or chord only |
| V | Next voice |
| L | Repeat this key |
| M | Microphone on or off |
| F | Filter on or off, for the mode you're in |
| K | Metronome |
| H | Show how you're doing, only where you sing, or nothing |
| + − 0 | Zoom the keyboard in, out, back to the whole exercise |
| N | Note labels |
| [ ] | Notes fall slower / faster |
| E S R | Exercises, Settings, Results |

## Singing without headphones (the filter)

The app knows what is being played, so it can take it out of what the mic hears. It learns how that sound reaches your mic, through the speakers and the room, and subtracts it, so only your voice is left, even when you sing the same note.

- **With the piano**, it takes the piano's own sound: the P-225 sends it to the computer over USB, and in Windows it shows up as an audio input, *Line (P-Series)*.
- **With the samples or the built-in synth**, it takes the app's own sound, exactly as it goes to your speakers. There is nothing to connect.

1. Press **Filter** at the top (F), or tick **Take the piano's sound out of what the mic hears** in Settings, under **Hear me over the piano**. With the piano, it finds *Line (P-Series)* by itself; to pick it by hand, it's under Sound, Piano, **The piano's USB audio** (the list fills once the mic is on; opened from the disk it stays empty, so press **Ask Chrome for the piano's input** and choose *Line (P-Series)* in Chrome's box). The bar under the list moves when you play a key. Next time it reconnects by itself, also when the piano is switched on after the page is open.
2. Press **Calibrate** and stay quiet. It plays three chords, a quick run over the exercise's range, then every key in it one at a time, as loud as your guide notes. It takes 15 to 20 seconds. The run teaches it the room; the single keys measure how much of each key is left after cancelling, since rooms leave much more of some notes than of others.

The calibration is remembered for that sound (the piano's input, or the app's sound) and mic, with everything measured in it. A session that only hears the reference chords keeps building on it without drifting away from it. Calibrate again after moving the laptop, the mic, the speakers or the volume.

**In Chord only** nothing plays while you sing, so the filter isn't used there: the mic is heard as it is, and it comes back by itself when you go back to *Play my notes*. The **Filter** button turns it on or off for the mode you're in (its dot: green working, amber still learning, grey off), and Settings has a tick for each mode. Turned off, it still follows the room, so turning it back on is instant.

**With headphones** the mic doesn't hear the piano or the app at all. The filter notices, and then simply listens to the mic as it is.

How it behaves:

- **Keys it hasn't heard aren't scored** while the piano plays them, so the piano can never sing a note for you. Without calibrating, it only learns the keys of the reference chords as they go by. That's enough for *Chord only*, but not for *Play my notes*.
- **Filter status:** Settings shows the measured delay between the piano (or the app's sound) and the mic, how many dB of it it removes, and how many keys it knows. 25 dB or more is good. The app's own sound arrives later than the piano's (the speakers take their time), up to almost half a second is fine.
- **A pitch the piano isn't playing is always heard.** What's left of the piano after cancelling only has the piano's own pitches. So when you're sharp, flat or on another note, you're heard straight away, however much piano is left.
- **On the very note the piano plays** your voice is heard when it stands out from what the room usually leaves of that key, either in loudness or frequency by frequency. The calibration also learns how much of the piano is left at each frequency, and how much of each key's overtones. A voice has its own pattern of harmonics, so several of them stand far above that piano leftover even when the voice is quieter than the piano overall. The piano's own leftover only does that here and there. Once your voice has been heard, it keeps being heard at a lower level while you hold that pitch.
- **Loud piano, quiet voice:** when too much of the piano is left for your voice to stand out, the app can't tell whether you sang. Those moments get no verdict rather than *not heard*, and a note mostly made of them gets none either. What helps most is a softer guide (**Your notes touch**) or the piano's volume a little lower, then the mic closer to you than to the piano's speakers, then calibrating again.

**Turn off the mic's own effects.** Laptop microphone arrays (Intel Smart Sound and the like) often adjust their own volume, suppress what they take for noise and aim at your voice, inside Windows, where the browser can't switch it off. The piano then reaches the mic differently from moment to moment, and no filter can keep up: it removes little of the piano and drops your singing. The app notices and says so under *Hear me over the piano*. To fix it: Windows Settings, System, Sound, under Input pick the microphone, set **Audio enhancements** to **Off** (or in More sound settings, Recording, the mic's Properties, tick *Disable all enhancements*). If the laptop has its own audio app (Realtek Audio Console, Dolby, Waves and so on), turn off noise suppression or voice focus there too. Then calibrate again. A plain USB mic avoids all of this.

**The filter lab** (`lab.html`, linked from Settings as *Open the filter lab*) tests the filter on its own, with **the piano**, **the samples** or **the built-in synth** (through your speakers). Press **Run the test**: it plays the calibration while you stay quiet, then an exercise to sing along to. **First note to sing** and **Last note to sing** set the range: do re mi re do on every key from the first to the last, a whole tone apart (E3 to C3 is three keys; E2 to E4, the whole range, thirteen). It says how long it will take. The lab remembers its settings. It then filters the recording with the app's own code and shows:

- the delay it found;
- how much of the piano (or the app's sound) it removed, by the room filter and after a clean-up of what that leaves;
- how much of your singing it could hear, and **note by note**, so you see where it struggles (low notes, say);
- how loud your voice was against the piano playing your notes;
- **a pitch chart**: the notes to sing, the pitch it heard as you (green on pitch, yellow close, red off), and, as hollow rings, pitches it read but couldn't tell from the piano.

You can listen to the mic, **what's left** (the piano removed and cleaned up: mostly your voice), what the room filter alone leaves, the piano as the filter predicts the mic hears it, and the piano's own audio (or what the app played). **Save the recording** keeps the test as a sound file to send for tuning. **Open a saved recording** runs a saved test through the filter as it is now, for instance after an update, without singing it again.

Recordings hold the mic, the piano's audio, and (when the piano's USB audio is stereo, as the P-225's is) a third channel with what differs between its left and right.

If the app still drops you, sing an exercise and press **Save the last 40 seconds**: the file holds what the mic and the piano's audio heard and what the app decided, for tuning the filter to your room.

If an input won't open, the line under it says why (blocked by the browser, used by another program, unplugged, or no answer). **Copy a device report**, at the end of this section, copies what the browser says about every input, to paste into a message.

## Making new exercises

Nothing needs registering. The app expects what the generator already writes:

- **Scales:** each round is a reference chord followed by the line to sing. Later rounds are transposed copies of the first. The key of each round comes from its reference chord, and key-signature events are not needed or used.
- **Songs** (no repeating rounds): the file is split into sections at the phrase breaks, and each section gets its own key from its notes.
- **What gets sung:** a track whose name contains *sing, voice, vocal, melody, lead, soprano, alto, tenor* or *baritone* is sung, and everything else plays. Without such names, single-line parts are sung and chords play.
- **Voices:** parts that move together are numbered from the top. An exercise can only score a voice that is in the file. In `voices_hard`, the melody that isn't written in the file can't be scored, but the voices that are written can.

## Privacy

Exercise files you add, the samples zip, the results and the room calibration are all kept in this browser's storage, under the name `scales-feedback`. Nothing is sent anywhere.

## GitHub Pages

1. On GitHub, create an empty **public** repository named `scales-feedback` (no README, licence or .gitignore, so the first push goes in cleanly).
2. Push this folder to it. `.gitignore` keeps zips and wav files out, so the piano samples are never published.

   ```
   cd C:\Users\yonab\Singing\scales-feedback
   git init -b main
   git add .
   git commit -m "Scales feedback app"
   git remote add origin https://github.com/yonabenreuven2/scales-feedback.git
   git push -u origin main
   ```

3. On the repository's page: **Settings**, **Pages**, *Deploy from a branch*, branch `main`, folder `/ (root)`, **Save**.
4. After a minute or two the site is at `https://yonabenreuven2.github.io/scales-feedback/`. Later changes go live a minute after each push.

It shares the `yonabenreuven2.github.io` origin with the other pages there, including the mic and MIDI permissions. Its storage keys all start with `scales-feedback`, so nothing clashes.

**The installed app's files:** `manifest.webmanifest`, `icons/`, `sw.js` (the service worker) and `js/pwa.js` (registers it, and offers the reload when files change). The service worker:

- checks with the server on every request (a quick "not modified" when nothing changed), so GitHub Pages' ten-minute caching never holds back a new version;
- keeps a copy of every file for offline use;
- reads what to keep from `index.html` and `lab.html` themselves, so it never needs editing when files are added or renamed;
- only touches caches named `scalesfeedback-…`, never the ear trainer's or the practice log's (cache storage is shared by the whole github.io site).

The manifest's `id` is `/scales-feedback/`. Chrome reads an `id` of `./` as the whole site, not the app's folder. The practice log's manifest has `./`, so the same here made Chrome take this app for the already installed practice log and open that instead.

The `?v=` numbers on the scripts are still bumped when they change, for a page opened without the service worker.

## Tests

```
node --test tests/*.test.js
```

The tests cover:

- the MIDI parser;
- the analysis of every exercise in `tests/fixtures`, plus exercises made up in the tests;
- the player's timing;
- the piano filter in a harder room too (an echo longer than it models, speakers that distort a little, a room that shifts): singing off the piano's note is heard however much piano is left, singing on it is heard when it stands out (also 12 dB under the piano, by its harmonics), and the piano alone almost never passes for a voice;
- low notes (below C3), heard by their harmonics and not credited from the piano alone;
- the clean-up of what the room filter leaves, and a room saved from last time that isn't spoiled by the first chords it hears again;
- the sound files the app and the lab save, read back;
- the service worker: what it keeps for offline use, serving the newest files, opening offline, and leaving other sites and other apps' caches alone;
- finding and opening the mic and the piano's input the way Chrome on Windows lists them (names hidden until allowed, or always on a page opened from the disk; Windows' default input; a piano input that is busy or never answers);
- scoring, and the breakdown of a run: every note's scale degree, the way the voice moved to it, how soon it settled and how steady it was; the summaries, what stands out, and what is kept with each run;
- the metronome: on the file's own beat (a dotted quarter in 6/8), counting in before a key, at the tempo set, silent on pause, and a click never counted as silence;
- the picture's geometry: which keys show, zooming, following what is about to be played, the key under the pointer, dragging the keyboard's edges;
- the filter turned off (the mic as it is), with headphones (nothing to remove), and with the app's own sound arriving late through the speakers;
- pitch detection;
- the samples zip reader;
- the listening engine;
- the piano filter in a simulated room. These cases take about a minute.
