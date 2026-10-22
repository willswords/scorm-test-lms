# Change log

## 2026-10-22

If the test LMS was running when you updated its files, restart it (Ctrl+C, then run it again). **Quiz answers** and **Completion criteria** need the updated server; the other changes only need a page reload.

- **Progress data size (`suspend_data`).** SCORM 1.2 LMSs only have to accept 4,096 characters (SCORM 2004: 4,000, or 64,000 in the 4th edition), and Storyline quizzes can go over late in the quiz without anyone noticing.
  - **Early warning:** an issue at 80% of the limit, with the size shown amber in the learner record.
  - **Over the limit:** an error issue explaining that progress will be lost on relaunch, and the size in red with the largest size tried.
  - **New "suspend_data over the limit" setting** (Package section, **LMS behaviour**):
    - **Reject it** (the default): error 405 in 1.2, 351 in 2004. SCORM 2004 values over the limit used to be stored with only a warning.
    - **Cut it off silently**, as some LMSs do.
    - **Store it all**, as lenient LMSs do.
- **SCORM 1.2 vs 2004 status checks.** Strict LMSs don't paper over these, so they're now flagged:
  - a SCORM 2004 element (such as `cmi.completion_status`) used in a 1.2 package, or a 1.2 one (`cmi.core.lesson_status`) in a 2004 package
  - a 1.2 value in 2004, such as `completion_status = "passed"`, with an explanation of where pass/fail goes instead
  - a 2004 course reporting `success_status = "passed"` but leaving `completion_status` incomplete
  - a score with `completion_status = "completed"` but no `success_status`
- **Close like a browser tab.** A new button (Package section, **LMS behaviour**) closes the course the way a learner closing the browser does: the calls it makes while closing are lost and shown crossed out in the log, so the LMS keeps only what was committed before. It flags values lost because they weren't committed yet, and an exit that wasn't set to "suspend" before the close, which means no resume next time. Then press **Relaunch**. Mid-quiz is where resume usually falls apart.
- **Resume check.** A course relaunched to resume that never reads back its `suspend_data` is flagged, because it probably started from the beginning.
- **Tested** with small SCORM 1.2 and 2004 test courses, covering:
  - all three over-limit settings in both versions
  - each status and element-name check
  - a browser-tab close mid-course: the four closing calls were lost, the committed progress was kept, and the uncommitted location was lost
  - a resume where the course ignored its saved data
- **Completion criteria.** The Package section now shows what decides whether the course counts as complete, in two layers.
  - **Set in the course:** the authoring tool's tracking settings.
    - **Articulate Storyline** (from `html5/data/js/data.js`): the quiz pass mark and/or the number of slides to view, for example "Pass the quiz “QUIZTest” with 80% or more" or "View all 17 slides (including 5 drawn from a question bank)". When a course has several options, it's complete when any one is met, and the first one met is reported. It also shows how Storyline reports to the LMS, such as Passed when met and Incomplete until then, with the SCORM fields it sets.
    - **SCORM Video Packager** (from `config.xml`): the watch threshold, the Mark as complete button, and the acknowledgement.
    - **Other tools:** the block says the rule isn't stated in a readable file.
  - **Set in the manifest (applied by the LMS):** the SCORM 1.2 mastery score, or the SCORM 2004 completion threshold and passing score, which override what the course reports. In packages with several items, it shows the selected item's rules and lists the other items' rules.
  - **Checked** against QUIZTest, the three Daily Report courses, Hangperson, a Video Packager package, and SCORM 2004 and xAPI test packages.

- **Completion alerts.** When the LMS records the course as complete or passed, the whole page pulses green and a message at the top shows what was recorded and when, for example `cmi.core.lesson_status = "completed"`, "Saved by the LMS at 0:02.014 into the session". A fail pulses red.
  - **When it fires:** when the change is saved (on commit, or when the course finishes), because a value the course sets but never commits wouldn't reach a real LMS.
  - **SCORM 2004:** completion and pass/fail are tracked separately, so a course can be "Marked complete, but failed". When the manifest has a completion threshold or passing score, the message says how the LMS worked the status out, for example "progress_measure 0.9 vs completion_threshold 0.8".
  - **xAPI:** it fires when the LRS receives a `completed`, `passed` or `failed` statement, including statements a course sends as soon as it opens.
  - **No repeats:** it only fires on a change during the current launch. Re-sending "completed", relaunching a learner who's already complete, and setting a status from **Learner status** don't set it off.
  - **Stays recorded:** the message disappears after 15 seconds (or click ×), but a highlighted line stays in the log and in the CSV.
  - **Reduced motion:** if your system is set to reduce motion, the page fades once instead of pulsing.
- **Quiz answers for Storyline courses.** A new **Quiz answers** section in the right panel lists every quiz question with its correct answer, read from the answer key Storyline writes into `html5/data/js/data.js`. The package's code is never run to do this.
  - **What it shows:** the question type, its points, and the quiz name and pass mark. Questions from a question bank are marked "bank", because the quiz may draw only some of them. When a question is only labelled something like "Multiple Choice", its wording is taken from the slide.
  - **Answers by question type:**
    - Multiple choice and true/false: the correct choice.
    - Multiple response: every box to tick.
    - Fill in the blank: each accepted spelling, noting when case doesn't matter.
    - Numeric: the number or range.
    - Matching: each item and its match.
    - Sequence: the items in order.
    - Hotspot: the area to click.
- **Pre-select correct quiz answers.** A new checkbox under **Storyline testing** makes questions open with the correct answer already filled in, so you only press Submit. This makes it quick to test passing, results and completion reporting.
  - **Multiple choice, multiple response and true/false:** the correct choices are ticked.
  - **Fill in the blank and numeric:** the box contains an accepted answer, such as the first accepted spelling or a number that meets the condition.
  - **Hotspot:** a click in the middle of the correct area is recorded, and the marker is shown there.
  - **Answer by hand:** matching, sequence and drag-and-drop questions can't be pre-filled; they're marked "answer by hand" under **Quiz answers**.
  - **Your package isn't changed.** As with the other Storyline options, only the answer values are swapped as the files are served.
  - **Resuming:** if the learner is resuming, Storyline restores their own saved answers instead, so use **Reset learner** for a clean run.
  - **Tested** with QUIZTest (10 questions) and QUIZTest-multipleQuestionTypesTest (9 questions of 7 types). Every pre-filled question was scored correct by Storyline, and QUIZTest was recorded as passed with 100%. It was also checked against a course that draws its questions from a question bank, including a multiple-response and a matching question.
- **Asks whether to clear the log when you open another package.** If the log has lines in it, a dialog asks before the new package opens, for example "It has 6 lines from “resend_noack.zip”".
  - **Clear log** (the default button) also removes the previous course's closing calls, and nothing from the new package is lost.
  - **Keep it**, or Esc, keeps everything and adds a divider line ("New package: …") where the new package starts.
  - **No question when the log is empty:** for example, when opening the first package.
- **Storyline testing has its own section.** It moved out of the Package section into its own section below it, which collapses like the others. It only appears for Storyline packages.
- **Resizable right panel.** Drag the panel's left edge to make it wider or narrower. It works smoothly over the course, without clicking anything in it or reloading it.
  - **Limits:** at least 300 pixels wide, and the course always keeps at least 360 pixels, including when the window is made smaller.
  - **Resetting:** double-click the edge to go back to 430 pixels.
  - **Keyboard:** Tab to the edge, then use ← / → (Shift for bigger steps), or Home to reset.
  - **Remembered:** the width is saved in your browser.
- **Hide the whole right panel.** A new **Hide panel** button in the header gives the course the full width, without relaunching or reloading it.
  - **To bring it back:** click the **Show LMS panel** tab on the right edge, or the header button.
  - **Issues stay visible:** the tab shows the number of issues so far, in red if any are errors.
  - **Remembered:** the choice is saved in your browser. On a phone-width screen the tab becomes a bar under the course.

## 2026-10-21

The test LMS moved from the SCORM Video Packager's repository to its own: [github.com/willswords/scorm-test-lms](https://github.com/willswords/scorm-test-lms). Its earlier history is copied below from that repository's change log.

If the test LMS was running when you updated its files, restart it (Ctrl+C, then run it again). **Close package** and the temp-file cleanup need the updated server; the other changes only need a page reload.

- **Download the log as a CSV file.** A new **↓ CSV** button next to Copy and Clear saves the log as a spreadsheet, named after the course (for example `My_Course-lms-calls-20261021-1423.csv`, or `…-lrs-requests-…` for xAPI).
  - **What it includes:** the same rows as Copy, with long values such as `suspend_data` in full (the log shortens them).
  - **Columns:** time since launch, clock time, type, the call or request, its arguments, the result, the error code and message, and notes.
  - **Excel:** the file opens directly in Excel, with characters such as "→" and curly quotes displayed correctly.
  - **"hide lookups":** the checkbox was "hide error lookups"; it was shortened to make room. Its tooltip has the full meaning.
- **SCORM 2004 support** (2nd, 3rd and 4th editions), alongside SCORM 1.2. The version is detected from the manifest, and only the matching LMS connection is offered. See the [README](README.md) for what it checks.
  - **Data model:** the full 2004 data model, with the 2004 error codes.
  - **Manifest settings:** the completion threshold and passing score from the manifest are applied.
  - **Attempts:** the 2004 attempt rules apply. Leaving without "suspend" starts a fresh attempt next time, and the previous result is shown. **Strict resume** is greyed out for 2004 packages, because the standard already behaves that way.
  - **Navigation:** navigation requests between items are followed.
- **xAPI (Tin Can) support, with a built-in LRS.** Packages with a `tincan.xml` now load, and are launched with the standard parameters (LRS address, login, learner, registration and activity ID).
  - **The LRS:** stores statements, saved state and profiles, and keeps them between restarts. It rejects what a real LRS would and flags it, for example a missing version header or login, a non-IRI verb, a score out of range, or a reused statement ID.
  - **What you see:** the log becomes **LRS requests**, with statements described in plain words, and the learner record shows completion, pass/fail, score, duration and saved state, worked out from the statements.
  - **Reset learner:** starts a new registration and clears saved state.
  - **cmi5:** packages are recognised and turned away with a "not supported yet" message.
- **Storyline testing: unlock navigation, the seekbar and Next/Prev.** For Articulate Storyline packages, the Package panel has a **Storyline testing** section with three checkboxes. Each relaunches the course so the player re-reads its settings.
  - **Free navigation (menu):** switches the menu `flow` between `"restricted"` and `"free"` in both `story_content/frame.xml` and `html5/data/js/frame.js` (the file the player reads).
  - **Unlock seekbar:** serves `frame.js` with the seekbar's `readonly` / `readonlyOnce` set to `false`, so the learner can drag it.
  - **Unlock Next/Prev buttons:** stops the slide triggers that disable Next, Prev and swiping from taking effect. Your packages have 44 to 176 such triggers each.
  - **Your package isn't changed.** Values are swapped only as the files are served. Unticking a box returns to the package's own behaviour, and each newly loaded package starts with its own settings.
  - **Tested** against all four Storyline packages in Downloads: every file still loads as valid Storyline data, and nothing besides the lock settings changes. In the running Case Study 1 course, Next and Prev went from disabled to enabled, and the seekbar from read-only to draggable.
  - **Limits:** a slide whose Next has no destination still won't move on, and buttons a slide hides stay hidden.
- **New guide: how navigation locking works in Storyline.** [`STORYLINE-NAVIGATION.md`](STORYLINE-NAVIGATION.md) explains where Storyline stores the menu, seekbar and Prev/Next locks, how the triggers work, how the test LMS unlocks each one and what it can't unlock. It also includes a survey of the four Storyline packages in Downloads.
- **No false alarm on quick relaunches.** Relaunching a slow-loading course (such as Storyline) before it had connected used to raise "The course never called LMSInitialize" (or the xAPI "never contacted the LRS"). These issues are now only raised if the course had at least 8 seconds. Shorter sessions get a note in the log instead.
- **Collapsible right-panel sections.** Package, Learner record, Issues and the call log each collapse to just their heading with a click, or with Tab and Enter.
  - **Log open:** collapsing other sections gives their room to the call log. For example, the log grew from about 190 to 520 pixels with Package and Learner record collapsed.
  - **Log collapsed:** the open sections grow to show their full contents.
  - **Issues count:** stays visible when Issues is collapsed.
  - **Remembered:** which sections are collapsed is saved in your browser.
- **SCORM version shown in the right panel.** A new **Package** section at the top shows a version badge, plus the manifest's declared version, the LMS connection used, and the number of course items.
- **Close package.** A new button unloads the package, deletes its unpacked files, and returns to the start screen, ready for you to drop in another package. The course's exit code runs first, and learner records are kept, so reopening the package later remembers the learner.
- **Temp files cleaned up.** Unpacked packages left behind when the test LMS was closed without Ctrl+C (for example by closing the terminal window) are now removed the next time it starts.

## 2026-10-14

### New: SCORM Test LMS

- A local test LMS for checking SCORM 1.2 packages before uploading them, including packages from other tools. Run `node scorm-test-lms.js`, then drop a `.zip` onto the page or pass a zip or folder on the command line. See the [README](README.md).
- Shows:
  - the course
  - the learner record
  - a list of issues
  - a log of every LMS call, which you can copy
- Checks the course's LMS calls like a real LMS: it rejects invalid values, read-only and write-only fields, and calls outside an open session, with the standard SCORM error codes.
- Applies the pass-mark rule: a score below the package's pass mark is recorded as failed.
- Flags common problems:
  - a course that never finds the LMS
  - no LMSFinish
  - changes never committed
  - no session time
  - leaving incomplete without asking to resume
- Controls:
  - relaunch and end session
  - set the learner's status
  - reset the learner
  - pick between course items in multi-item packages
  - "Strict resume", which copies LMSs that discard progress when a course doesn't ask to resume
