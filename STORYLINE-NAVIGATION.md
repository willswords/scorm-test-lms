# How navigation locking works in Storyline packages

This guide explains how an Articulate Storyline 360 package stops learners from moving freely. There are three separate locks:

1. **The menu**, which controls whether learners can jump between slides.
2. **The seekbar**, which controls whether learners can drag through a slide's timeline.
3. **The Prev and Next buttons**, which slides can disable until a condition is met.

Each lock lives in a different place in the published files. The guide also shows how the SCORM Test LMS's **Storyline testing** checkboxes unlock each one for testing.

Everything here comes from inspecting four real Storyline packages (listed in [What's in these packages](#whats-in-these-packages)), including their files and the running Storyline player. Storyline's internal format isn't documented by Articulate, so treat field names as what these packages contain, not as a published specification.

---

## Where the settings live

A Storyline HTML5 package has this structure (inside the zip, sometimes within one top-level folder):

| File | What it holds |
|---|---|
| `story_content/frame.xml` | An XML copy of the player settings, including the menu navigation setting. The HTML5 player doesn't read it at runtime; it reads `frame.js`. |
| `html5/data/js/frame.js` | **The player settings the HTML5 player actually reads**: menu, seekbar, controls, layouts, text labels. |
| `html5/data/js/data.js` | The course structure: scenes, the list of slides, and course-wide variables. |
| `html5/data/js/<slide id>.js` | One file per slide, for example `5jodlGgkEZS.js`. Each holds that slide's objects, layers, **triggers** and button actions. |
| `html5/data/js/paths.js` | Vector shapes. It isn't relevant to navigation. |

### The file format

The `.js` data files aren't ordinary JavaScript. Each one hands a JSON document to the player as a text string:

```js
window.globalProvideData('frame', '{"version":3,"menuOptions":{"flow":"restricted", … }, … }');
```

The JSON is inside quotes, so depending on how it was published, the inner quotes may be backslash-escaped (`\"flow\":\"restricted\"`). Anything that edits these files must handle both forms, and must keep the result valid JSON. Otherwise the player fails to load that slide.

---

## 1. Menu navigation

**In Storyline:** Player Properties → Menu → navigation restriction.

**In the files:**

| File | Setting |
|---|---|
| `html5/data/js/frame.js` | `"menuOptions":{"flow":"restricted", …}` |
| `story_content/frame.xml` | `<option name="flow" value="restricted" />` |

The values Storyline uses:

| Value | Effect on the menu |
|---|---|
| `free` | The learner can jump to any slide. |
| `restricted` | The learner can open the current slide and slides already viewed, but not ones ahead. |
| `locked` | The menu can't be used to jump; slides must be viewed in order. |

Notes:

- `restricted` relies on knowing which slides have been viewed. That's part of the course's saved progress, so on relaunch, the menu reflects what was viewed in earlier sessions.
- Only `frame.js` matters at runtime. Storyline publishes `frame.xml` alongside it with the same setting, and the test LMS changes both so they stay consistent.
- `data.js` also has a per-slide `"slideLock"` field. It was `false` on every slide in these packages, and the test LMS doesn't change it.

---

## 2. The seekbar

**In Storyline:** Player Properties → Features → Seekbar. You can show or hide it, and choose whether the learner may drag it.

**In `frame.js`:** the `controls` object:

```json
"controls": { "volume": true, "seekbar": true, "readonly": true, "readonlyOnce": true, … }
```

| Field | Meaning |
|---|---|
| `seekbar` | The seekbar is shown. |
| `readonly` | The learner can't drag the seekbar. |
| `readonlyOnce` | Combined with `readonly`, appears to mean the seekbar is read-only only until the slide has been viewed once, then becomes draggable. This matches Storyline's option to allow dragging after a slide is complete. |

So `readonly: false` means free dragging, and `readonly: true` means read-only. With `readonlyOnce` also `true`, the lock seems to apply only on a slide's first viewing. This reading is inferred from the setting names and the player's behaviour; Articulate doesn't document these fields.

**Per-slide changes:** slides can switch to a different control layout (see [Layouts](#layouts-which-controls-a-slide-shows)), which can hide the seekbar. A slide trigger can also disable it with `enable_window_control` named `seekbar`. None of these four packages do that.

**In the running player:** the seekbar element is `#seek`. When locked, it has the class `read-only`.

---

## 3. Prev and Next buttons

The Prev and Next buttons have no single "locked" setting. Each slide controls them with **triggers**, which are stored in that slide's `.js` file.

### Disabling and enabling

A slide's triggers run actions like:

```json
{ "kind": "enable_window_control", "name": "next", "enable": false, "affectTabStop": false }
```

| `name` | Control |
|---|---|
| `next` | The Next button |
| `previous` | The Prev button |
| `swiperight` | The swipe gesture for Next on touch screens |
| `swipeleft` | The swipe gesture for Prev on touch screens |

A typical pattern, from slide `5jodlGgkEZS` in Case Study 1:

**When the slide starts** (`onslidestart`), it checks a course variable (here `page9`):

- if it's **true**, it shows and **enables** Next and the swipe;
- if it's **false**, it shows Next but **disables** it and the swipe.

So Next stays locked until something elsewhere in the course sets `page9` to true. Other slides use the same action during the slide, for example to enable Next when the timeline ends or the learner has clicked everything. This is the usual Storyline pattern "disable Next until the learner has done X".

### Showing and hiding

`{ "kind": "set_window_control_visible", "name": "next", "visible": false }` hides a button instead of disabling it. **A hidden button isn't a locked button.** The test LMS doesn't change visibility.

### What clicking does

Each slide also defines what the buttons do when clicked:

| Action group | Purpose |
|---|---|
| `ActGrpOnNextButtonClick` | What Next does, usually `gotoplay` with the next slide's ID. It may be wrapped in an `if_action` condition. |
| `ActGrpOnPrevButtonClick` | The same for Prev. |
| `NavigationRestrictionNextSlide_<slide id>` / `NavigationRestrictionPreviousSlide_<slide id>` | Small groups that just run the click groups above. Storyline appears to use them to send other navigation through the same rules. They're left unchanged. |

If a slide's `ActGrpOnNextButtonClick` is empty (`"actions":[]`), Next has **no destination** on that slide, even when enabled. The slide is designed to move on through its own on-screen buttons instead. Case Study 1 and Part 1 each have one such slide.

### Layouts: which controls a slide shows

`frame.js` has `controlLayouts`, a set of named layouts with generated names such as `pxabnsnfns10111001101`. Each layout says which controls are present, for example `"previous": true, "next": true, "seekbar": true`. Before each slide appears, a trigger (`set_frame_layout` or `set_window_control_layout`) picks its layout. That's how one slide can have no Prev button while the next one does. Layouts decide whether a control is there at all, while `enable_window_control` decides whether it works.

### In the running player

The buttons are `#prev` and `#next`. When disabled, they have the class `cs-disabled` and `aria-disabled="true"`, and are dimmed to 50% opacity.

---

## How the SCORM Test LMS unlocks them

In the Package panel, **Storyline testing** appears when a package contains `story_content/frame.xml` or `html5/data/js/frame.js`. Every change is made **as the files are sent to the course**. The package, the zip, and an unzipped folder are never modified. Each box relaunches the course so the player re-reads its files. Unticking a box serves the files exactly as packaged again, and each newly loaded package starts with its own settings.

| Box | What's changed as the files are served |
|---|---|
| **Free navigation (menu)** | `"flow"` inside `menuOptions` in `frame.js`, and `<option name="flow" value="…">` in `frame.xml`, become `"free"`. Unticking serves `"restricted"`. Other `flow` keys in the file are left alone. |
| **Unlock seekbar** | `"readonly"` and `"readonlyOnce"` inside `frame.js`'s `controls` become `false`, and any slide trigger that disables `seekbar` is served with `"enable": true`. |
| **Unlock Next/Prev buttons** | In every file in `html5/data/js` except `frame.js`, triggers that disable `next`, `prev`, `previous`, `swiperight` or `swipeleft` are served with `"enable": true`. Triggers that enable controls, show or hide them, or run click actions are not touched. |

The panel notes show what the package does and what's being swapped. For example:

```
html5/data/js/frame.js: "restricted" → served as "free"
Seekbar is read-only until a slide has been viewed once → served as draggable.
44 trigger(s) in 11 slide(s) disable Next/Prev → kept enabled.
```

A box is greyed out when there's nothing for it to unlock.

### Checked against the real packages

For all four packages below:

- **Changes:** every lock trigger was switched, and the seekbar settings changed where they were locked.
- **Nothing else changed:** comparing each file before and after showed that only the lock values differ.
- **Still valid:** every file still loads as valid Storyline data, checked by running it the way the player does.
- **In the running Case Study 1 course:**
  - **Next and Prev:** disabled as packaged (`cs-disabled`), enabled with the box ticked.
  - **Seekbar:** read-only as packaged, draggable with the box ticked.

### What it doesn't unlock

- **Slides with no Next destination.** If `ActGrpOnNextButtonClick` is empty, enabling Next has nothing to go to. Use the slide's own buttons, or **Free navigation** to jump past it from the menu.
- **Hidden buttons.** Buttons hidden by `set_window_control_visible` or a slide's layout stay hidden.
- **On-slide buttons and layers gated by variables.** Custom "Continue" buttons, tabs and layers that wait for a variable are ordinary slide objects, not player controls, so they keep their conditions.
- **The "locked" menu value.** For a package that uses `"locked"`, unticking **Free navigation** serves `"restricted"`, not `"locked"`. Close and reopen the package to get its original behaviour back.
- **Resume data.** Which slides count as "viewed" comes from the learner's saved progress (`suspend_data`). Use **Reset learner** to test as a new learner.

---

## What's in these packages

Surveyed from the Storyline packages in Downloads:

| Package | Menu `flow` | Seekbar (`readonly` / `readonlyOnce`) | Slides | Triggers disabling Next / Prev / swipe | Triggers enabling Next / swipe | Slides where Next has no destination |
|---|---|---|---|---|---|---|
| Radiation Safety for Cardiovascular Lab Personnel | `restricted` (`frame.js` only, no `frame.xml`) | `false` / `false` (already draggable) | 58 | 59 / 58 / 59 | 58 / 58 | 0 |
| Construction … Case Study 1 | `restricted` | `true` / `true` | 11 | 21 / 2 / 21 | 17 / 17 | 1 |
| Construction … Introduction v2 | `restricted` | `true` / `true` | 22 | 29 / 13 / 29 | 29 / 29 | 0 |
| Construction … Part 1 v2 | `restricted` | `true` / `true` | 11 | 21 / 2 / 21 | 17 / 17 | 1 |

Observations:

- **Radiation Safety** has a trigger disabling Prev in nearly every slide file, and none re-enabling it, so the Prev button can't be used to go back. It also has a Next-disabling trigger and a Next-enabling trigger in almost every slide.
- **Introduction v2:** Next-disabling triggers (29) and Next-enabling triggers (29) match exactly.
- **Case Study 1 and Part 1** each have four more Next-disabling triggers than enabling ones (21 against 17). Some locks are only lifted by on-slide buttons or by reaching another slide. One slide in each has no Next destination at all.
