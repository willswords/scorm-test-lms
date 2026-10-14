# SCORM Test LMS (SCORM 1.2)

A local test LMS for checking SCORM 1.2 packages before uploading them to a real LMS. Use it for packages from the SCORM Video Packager or from other tools (Articulate, Captivate, etc.). It shows every call the course makes to the LMS, what gets saved, and anything that a real LMS might reject or handle differently.

## Requirements

[Node.js](https://nodejs.org) 18 or later. Nothing else needs installing.

## Running it

```
node scorm-test-lms.js
```

Your browser opens the test LMS. Drop a SCORM `.zip` onto the page, or click **Open package…**.

You can also start it with a package already loaded. Pass either a `.zip` or an unzipped folder:

```
node scorm-test-lms.js "C:\path\to\My_Course_SCORM12.zip"
```

Options: `--port 7831` uses a different port. `--no-open` skips opening the browser. Press **Ctrl+C** in the terminal to stop the test LMS.

Only this computer can reach the test LMS. Unzipped packages go in a temporary folder that is cleaned up when you load another package or stop the tool.

## What you see

- **Course:** the course runs on the left, inside the test LMS, just as it would in a real LMS.
- **Learner record:** what the LMS has stored for this learner (status, score, location, saved progress, total time). It also shows the current session: whether the course has started and finished its LMS session, its exit value, the session time, and how many changes are waiting to be saved.
- **Issues:** problems a real LMS could trip over. Examples:
  - invalid values
  - writing read-only fields
  - calls after LMSFinish
  - changes never committed
  - no session time
  - leaving incomplete without `cmi.core.exit = "suspend"`
  - a course that never finds the LMS
- **LMS calls:** every call, with its result and any SCORM error code. **Copy** puts the log on your clipboard to share.

## Controls

| Control | What it does |
|---|---|
| **Launch / Relaunch** | Closes the course (its exit code runs) and opens it again, like a learner returning. |
| **End session** | Closes the course, like a learner closing the window. |
| **Learner status** | Sets the stored status (for example "passed") and relaunches, to test returning learners. |
| **Reset learner** | Erases this learner's record for this course and starts over. |
| **Strict resume** | Copies a common LMS behaviour: if the course leaves incomplete without asking to resume (`cmi.core.exit = "suspend"`), the next launch starts a fresh attempt and saved progress is discarded. Leave this off for a forgiving LMS. |
| **Course item picker** | Appears when a package contains more than one launchable item. |

Learner records are saved in your browser, separately for each course, so they survive restarting the tool.

## Limits

- **SCORM 1.2 only.** SCORM 2004 packages are detected and flagged, but they can't run because they look for a different LMS connection.
- **It isn't a real LMS.** It checks the SCORM 1.2 data model and common mistakes, but every LMS has its own quirks. Do a final check in your actual LMS, or in Rustici's SCORM Cloud (it has a free tier).
- **ZIP64 files aren't read.** That means packages over 4 GB, or with more than 65,535 files. Unzip the package and run the tool on the folder instead.
