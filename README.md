# SCORM Test LMS (SCORM 1.2, SCORM 2004 and xAPI)

A local test LMS for checking e-learning packages before uploading them to a real LMS. Use it for packages from the SCORM Video Packager or from other tools (Articulate, Captivate, iSpring, etc.). It shows everything the course sends to the LMS, what gets saved, and anything that a real LMS might reject or handle differently.

It supports:

- **SCORM 1.2** and **SCORM 2004** (2nd, 3rd and 4th editions), read from the package's `imsmanifest.xml`. As in a real LMS, only the matching LMS connection is offered: `window.API` for 1.2, `window.API_1484_11` for 2004.
- **xAPI (Tin Can)** packages, which have a `tincan.xml`. These talk to an LRS (Learning Record Store) over the web, so the test LMS includes one. See [xAPI behaviour](#xapi-behaviour) below.

The header and the **Package** panel show which kind of package is loaded.

What changed in each update is in [CHANGELOG.md](CHANGELOG.md).

## Requirements

[Node.js](https://nodejs.org) 18 or later. Nothing else needs installing.

## Running it

Open a Terminal and type:

```
node scorm-test-lms.js
```

or if that doesn't work, specify the exact location of the file you downloaded:

```
node "C:\Users\yourusername\pathtothefile\...\scorm-test-lms.js"
```

Your browser opens the test LMS. Drop a SCORM `.zip` onto the page, or click **Open package…**.

You can also start it with a package already loaded. Pass either a `.zip` or an unzipped folder:

```
node scorm-test-lms.js "C:\path\to\My_Course_SCORM12.zip"
```

Options: `--port 7831` uses a different port. `--no-open` skips opening the browser. Press **Ctrl+C** in the terminal to stop the test LMS.

Only this computer can reach the test LMS. Unzipped packages go in a temporary folder. They're cleaned up when you load another package or stop the tool, and anything left behind by a run that was closed some other way is removed the next time it starts.

## What you see

- **Course:** the course runs on the left, inside the test LMS, just as it would in a real LMS.
- **Package:** at the top of the right panel, a badge shows the SCORM version in use (for example "SCORM 2004 · 4th edition"). Below it are the version the manifest declares, the LMS connection the course is given, and the number of course items.
- **Completion criteria:** in the Package section, what decides whether the course counts as complete, in two layers:
  - **Set in the course:** the authoring tool's tracking settings, where the test LMS can read them.
    - **Articulate Storyline:** read from `html5/data/js/data.js`, for example "Pass the quiz with 80% or more" or "View all 17 slides". When a course has several options, it's complete when any one is met, and the first one met is reported. Also shown: what Storyline reports when the criteria are met and before then, with the SCORM fields it sets.
    - **SCORM Video Packager:** read from `config.xml`: the watch threshold, the Mark as complete button, and the acknowledgement.
  - **Set in the manifest (applied by the LMS):** the SCORM 1.2 mastery score, or the SCORM 2004 completion threshold and passing score. These override what the course reports. In packages with several items, each item's rules are shown when it's selected, and other items' rules are listed.
- **Quiz answers:** for Storyline packages with quiz questions, a section listing every question and its correct answer, read from the answer key Storyline writes into `html5/data/js/data.js`.
  - **What it shows:** the question type, its points, and the quiz name and pass mark.
  - **Answers by question type:**
    - Multiple response: every box to tick.
    - Fill in the blank: each accepted spelling, noting when case doesn't matter.
    - Numeric: the number or range.
    - Matching: each item and its match.
    - Sequence: the items in order.
    - Hotspot: the area to click.
  - **Question banks:** questions drawn from a bank are marked "bank", because the quiz may use only some of them, in any order.
  - **Question wording:** when a question is only labelled something like "Multiple Choice", its wording is taken from the slide.
- **Learner record:** what the LMS has stored for this learner (status, score, location, saved progress, total time). It also shows the current session: whether the course has started and finished its LMS session, its exit value, the session time, and how many changes are waiting to be saved. For SCORM 2004 it also shows the attempt number and the previous attempt's result.
- **Completion alerts:** when the LMS records the course as complete or passed, the whole page pulses green and a message at the top shows what was recorded and when. A red pulse marks a fail.
  - **When it fires:** when the change is saved (on commit, or when the course finishes), because a value the course sets but never commits wouldn't reach a real LMS.
  - **Worked out by the LMS:** for SCORM 2004 packages with a completion threshold or passing score, the message says how the status was worked out, for example "progress_measure 0.9 vs completion_threshold 0.8".
  - **xAPI:** it fires when the LRS receives a `completed`, `passed` or `failed` statement.
  - **No repeats:** it only fires on a change in the current launch. A learner who was already complete doesn't trigger it on relaunch, and neither does a status you set from **Learner status**.
  - **Stays recorded:** the message disappears after 15 seconds (or click ×), but a highlighted line stays in the log and in the CSV.
  - **Reduced motion:** if your system is set to reduce motion, the page fades once instead of pulsing.
- **Issues:** problems a real LMS could trip over. Examples:
  - invalid values
  - writing read-only fields
  - calls before the session starts or after it ends
  - changes never committed
  - no session time
  - leaving incomplete without asking to resume (`suspend`)
  - a course that never finds the LMS
  - `suspend_data` nearing or going over the size every LMS must accept (see [Progress data size](#progress-data-size))
  - SCORM 1.2 and 2004 mixed up: a 2004 element such as `cmi.completion_status` used in a 1.2 package, or a 1.2 one such as `cmi.core.lesson_status` in a 2004 package, or a 1.2 value such as `completion_status = "passed"`
  - a SCORM 2004 course reporting `success_status = "passed"` but not `completion_status = "completed"` (lenient LMSs count it as done; strict ones don't), or a score with no `success_status`
  - a course relaunched to resume that never reads back its `suspend_data`
- **LMS calls:** every call, with its result and any SCORM error code. **hide lookups** hides the course's error lookups (`GetLastError`, `GetErrorString` and `GetDiagnostic`), which most courses make after every call.
  - **Copy** puts the log on your clipboard to share.
  - **↓ CSV** downloads the log as a spreadsheet (`<course>-lms-calls-<date>-<time>.csv`, or `…-lrs-requests-…` for xAPI). It has one row per log line, with the same rows as Copy. Long values such as `suspend_data`, shortened in the log, are in full. The columns are:
    - Time since launch, and Clock time
    - Type (Call, Error lookup, Note or LRS request)
    - Call or request
    - Argument 1 and Argument 2 (for example, the data model element and the value)
    - Result
    - Error code and Error
    - Notes (the text of notes, plus xAPI summaries and statements)

Click a section's heading, or Tab to it and press Enter, to collapse or expand it.
- **With the log open:** the log gets the room the collapsed sections free up.
- **With the log collapsed:** the open sections grow to show their full contents.
- **Always visible:** the Issues count stays in view when Issues is collapsed.
- **Remembered:** which sections are collapsed is saved in your browser.

## Controls

| Control | What it does |
|---|---|
| **Launch / Relaunch** | Closes the course (its exit code runs) and opens it again, like a learner returning. |
| **End session** | Closes the course, like a learner closing the window. |
| **Learner status** | Sets the stored status (for example "passed") and relaunches, to test returning learners. |
| **Reset learner** | Erases this learner's record for this course and starts over. |
| **Edit suspend_data** | The **Edit** button next to `suspend_data` in the learner record (SCORM only) opens what the LMS has saved for this learner, with a character count against the limit (red when over). **Save and relaunch** closes the course (its exit code runs first, so it can't overwrite your edit), stores your text, and relaunches. **Relaunch as a resume** (on by default) makes the course read it back, as a course starting fresh doesn't. Useful for testing how a course copes with damaged, old or oversized progress data, or for jumping a learner to a later point. |
| **suspend_data over the limit** | In the Package section, under **LMS behaviour**. What this LMS does when the course saves more progress data than every LMS must accept: **Reject it** (an error, the default), **Cut it off silently**, or **Store it all** (as lenient LMSs do). Remembered in your browser. See [Progress data size](#progress-data-size). |
| **Close like a browser tab** | In the Package section, under **LMS behaviour**. Closes the course the way a learner closing the browser does: the calls it makes while closing are lost (browsers often block what a closing page sends), so the LMS keeps only what was committed before and never gets the finish call. They're shown crossed out in the log. Then press **Relaunch** to see what the learner gets back. Mid-quiz is the place to try it. |
| **Strict resume** | SCORM 1.2 only. Copies a common LMS behaviour: if the course leaves incomplete without asking to resume (`cmi.core.exit = "suspend"`), the next launch starts a fresh attempt and saved progress is discarded. Leave this off for a forgiving LMS. |
| **Course item picker** | Appears when a package contains more than one launchable item. |
| **Storyline testing** | Its own section in the right panel, below Package, shown only for Articulate Storyline packages (those with `story_content/frame.xml` or `html5/data/js/frame.js`). Each box relaunches the course when changed. The values are swapped as the test LMS serves the files, so your package is never changed, and each newly loaded package starts with its own settings. For how Storyline's locks work, see [STORYLINE-NAVIGATION.md](STORYLINE-NAVIGATION.md). |
| &nbsp;&nbsp;**Free navigation (menu)** | Switches the menu `flow` in `frame.xml` and `frame.js` between `"restricted"` and `"free"`, so the learner can jump to any slide from the menu. |
| &nbsp;&nbsp;**Unlock seekbar** | Makes the seekbar draggable. It sets `"readonly"` and `"readonlyOnce"` in `frame.js`'s `controls` to `false`, and stops any slide trigger from disabling the seekbar. Greyed out if the package doesn't lock the seekbar. |
| &nbsp;&nbsp;**Unlock Next/Prev buttons** | Keeps Next and Prev (and the matching swipe gestures) enabled. Slide triggers that disable them (`enable_window_control … "enable":false`) are served as `true`. The note shows how many such triggers the package has. If a slide's Next button has no destination (the slide moves on through its own buttons instead), enabling it still won't move on. Hidden buttons stay hidden. |
| &nbsp;&nbsp;**Pre-select correct quiz answers** | Questions open with the correct answer already filled in, so you only press Submit. This makes it quick to test passing, results and completion reporting. Only the answer values change as the files are served:<br/>• **Multiple choice, multiple response and true/false:** the correct choices are ticked.<br/>• **Fill in the blank and numeric:** the box contains an accepted answer, such as the first accepted spelling or a number that meets the condition. The test LMS also sends a key press to the box, because Storyline only reads a box's text once something has been typed in it.<br/>• **Hotspot:** a click in the middle of the correct area is recorded, and the marker is shown there.<br/>Matching, sequence (drag and drop or drop-down) and drag-and-drop questions can't be pre-filled. Answer them by hand using **Quiz answers**. If the learner is resuming, Storyline restores their own saved answers instead, so use **Reset learner** for a clean run. |
| **⚙ Sections** | Opens **Panel sections**, where you choose which sections the right panel shows. The choices are Package (and, within it, Completion criteria and LMS behaviour), Storyline testing, Quiz answers, Learner record, Issues and the call log. Changes apply as you tick, and are remembered in your browser. **Show all** turns everything back on. Storyline testing and Quiz answers still only appear for packages they apply to. If you turn everything off, the panel says so and offers a button to choose again. Turning a section off only hides it: the log keeps recording, issues are still counted (the Show LMS panel tab shows the count), and completion alerts still appear. |
| **Panel width** | Drag the panel's left edge (the line turns blue when you point at it) to make it wider or narrower, between 300 pixels and whatever leaves the course 360 pixels. Double-click the edge to reset it to 430. From the keyboard: Tab to the edge, then ← / → (hold Shift for bigger steps) or Home to reset. Remembered in your browser. |
| **Hide panel / Show panel** | Hides the whole right panel so the course gets the full width. It doesn't relaunch or reload the course. While hidden, a **Show LMS panel** tab runs down the right edge of the page, with the number of issues so far (red if any are errors). Click it, or the header button, to bring the panel back. Completion alerts still appear while the panel is hidden, and the choice is remembered in your browser. |
| **Open package…** | Opens another package; you can also drop a `.zip` anywhere on the page. If the log has lines in it, you're asked first whether to clear it. **Clear log** removes everything, including the previous course's closing calls. **Keep it** (or Esc) keeps the log and adds a divider line where the new package starts. |
| **Close package** | Closes the course (its exit code runs), unloads the package and deletes its unpacked files, and returns to the start screen. Learner records are kept, so reopening the package later remembers the learner. |

Learner records are saved in your browser, separately for each course, so they survive restarting the tool.

## SCORM 2004 behaviour

The test LMS follows the SCORM 2004 rules that most often trip courses up:

- **Error codes:** calls get the 2004 error codes. For example, a call before `Initialize` gets 122 or 132, one after `Terminate` gets 123, 133 or 143, a value that was never set gets 403, and setting an objective's field before its `id` gets 408.
- **Completion threshold and passing score:** these come from the manifest (`adlcp:completionThreshold`, and the `imsss` primary objective's `minNormalizedMeasure`). When set, the LMS works out `completion_status` and `success_status` from the course's `progress_measure` and `score.scaled`, overriding what the course reports, and notes this in the log.
- **Attempts:** leaving with `cmi.exit = "suspend"` lets the next launch resume. Any other exit ends the attempt, so the next launch starts a fresh one with saved progress cleared. That's why **Strict resume** isn't needed for 2004. The previous attempt's result stays visible.
- **Navigation requests:** `adl.nav.request` is acted on when the course calls `Terminate`. `continue`, `previous` and `{target=…}choice`/`jump` open the matching item. `exit`, `exitAll`, `suspendAll` and `abandon` close the course. The `adl.nav.request_valid.*` values answer accordingly.
- **Size limits:** every LMS must accept 64,000 characters of `suspend_data` in the 4th edition, 4,000 in earlier editions. See [Progress data size](#progress-data-size).

## Progress data size

Courses save the learner's progress in `suspend_data`. The most every LMS must accept is 4,096 characters in SCORM 1.2, and 4,000 in SCORM 2004 (64,000 in the 4th edition). Storyline quizzes add to it with every question, so a course can go over late in the quiz. A lenient LMS hides the problem; a strict one rejects the value or cuts it off, the course rarely notices, and the learner's progress is lost or damaged on relaunch.

- **Early warning:** an issue at 80% of the limit, and the size turns amber in the learner record.
- **Over the limit:** an error issue, and the size turns red with the largest size tried (for example "3,400 / 4,096 chars · tried 5,000").
- **Choose the LMS's behaviour** under **LMS behaviour** in the Package section:
  - **Reject it:** the call fails (error 405 in SCORM 1.2, 351 in 2004) and the old value is kept.
  - **Cut it off silently:** stored up to the limit with no error, so the course gets damaged data back.
  - **Store it all:** kept in full, with a warning that strict LMSs differ.
- **To test resuming:** close or relaunch the course mid-quiz, especially with **Close like a browser tab**, and check that it picks up where it left off.

## xAPI behaviour

- **Launching:** the course is launched with the standard "Tin Can launch" parameters that Articulate, Captivate, iSpring and others expect:
  - `endpoint`, the address of the built-in LRS: `http://localhost:7830/xapi/`
  - `auth` (login details) and `actor` (a test learner, "Learner, Test")
  - `registration`, which identifies this learner's enrolment
  - `activity_id`
- **The built-in LRS** supports what these courses use:
  - statements (sending, single and batched, and reading back)
  - saved state, which is how courses resume
  - activity and agent profiles
  - `/about`
  - the older "alternate request" format
- **Checks a real LRS makes** are applied. These are rejected and flagged as issues:
  - a request missing the `X-Experience-API-Version` header (400) or `Authorization` (401)
  - a verb or activity ID that isn't a full IRI (web address)
  - `result.score.scaled` outside −1 to 1
  - true/false values sent as text
  - properties that aren't in the xAPI spec
  - a statement ID reused for a different statement (409)
  - a profile overwritten without `If-Match` (409)
  - a stale `If-Match` (412)
- **Warnings without rejecting:** statements without the launch `registration` (LMSs use it to link statements to the learner's enrolment), a different learner than the one launched, and verbs without a display name.
- **What you see:**
  - **Learner record:** worked out from the statements for the current registration, the way an LMS would: completion, pass/fail, score, duration, how many statements, and the saved state documents.
  - **LRS requests:** this log replaces "LMS calls", with one line per request, and statements described in plain words, for example `Learner, Test passed "Course" (score 0.9, success)`.
- **Controls:**
  - **Reset learner** gives the learner a new registration and deletes their saved state. Earlier statements stay in the LRS, because statements can't be deleted in xAPI.
  - **Learner status** and **Strict resume** are SCORM-only.
- **Saved to disk:** LRS data is saved in `lrs-data.json` in your temp folder (`%TEMP%\scorm-test-lms`), so it survives restarting the tool.

## Limits

- **It isn't a real LMS.** It checks the SCORM data model and common mistakes, but every LMS has its own quirks. Do a final check in your actual LMS, or in Rustici's SCORM Cloud (it has a free tier).
- **No SCORM 2004 sequencing engine.** Navigation requests are followed in manifest order, but sequencing rules, rollup across items, and shared (global) objectives aren't applied. Each item's record is kept separately.
- **No cmi5.** cmi5 packages (with a `cmi5.xml`) are recognised and turned away with a message; only "Tin Can" style xAPI packages run.
- **No xAPI attachments.** Statements with attachments (`multipart/mixed`) are rejected and flagged. These are rare in e-learning.
- **ZIP64 files aren't read.** That means packages over 4 GB, or with more than 65,535 files. Unzip the package and run the tool on the folder instead.
