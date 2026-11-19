// AttendEase UI controller. Data rules are in data.js; the login version stores data in Supabase.
const STORAGE_KEY = "attendease-frontend-demo-v2";   // used only by the no-login version
const AUTH = window.AttendEaseAuth || null;            // only exists in the login version
const Data = window.AttendEaseData;
const SAMPLE_DATA = window.ATTENDEASE_SAMPLE_DATA;

const store = Data.createStore();
// these lists are changed in place by the store, so these names always show the latest data
const { courses, students, sheets } = store.state;
let cloudSaveQueue = Promise.resolve();

// ===== what the professor picked on the screen =====
let selectedCourseId = null;
let attendanceDate = getToday();
let marks = {};                // marks on the attendance page, like { 1: "present", 2: "late" }
let unsaved = false;           // true when marks were changed but not saved yet
let sortAZ = { attendance: true, classlist: true };
let oldestFirst = { sheets: false, preview: true };
let sheetsByBlock = false;     // Saved Sheets: false = sort by date, true = sort by program/block
let sheetFilter = { program: "all", course: "all", block: "all" };
let previewNumber = "";        // student picked in Student Preview
let previewCode = "";          // course code picked in Student Preview
let previewProgram = "all";
let previewBlock = "all";
let editingStudentId = null;   // null means we are adding a new student
let editingCourse = false;     // false means we are adding a new course
let onConfirm = null;          // what to do when "Yes" is clicked in the confirm box
let focusBeforeModal = null;   // so focus goes back to the button that opened the pop-up

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TITLES = { attendance: "Attendance Overview", classlist: "Class List", sheets: "Saved Sheets", preview: "Student Preview", settings: "Settings" };
const $ = (id) => document.getElementById(id);

// the Program / Course / Block dropdowns are the same on 2 pages, so we add them with JS
const filterHtml = `
  <label class="field"><span class="label">Program</span><span class="select-box"><select class="program-select"></select></span></label>
  <label class="field wide"><span class="label">Course</span><span class="select-box"><select class="course-select"></select></span></label>
  <label class="field"><span class="label">Block</span><span class="select-box"><select class="block-select"></select></span></label>`;


// ===================== small helper functions =====================

function getToday() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function longDate(text) {      // 2026-10-27 -> October 27, 2026
  const [year, month, day] = text.split("-");
  return MONTHS[month - 1] + " " + Number(day) + ", " + year;
}

function shortDate(text) {     // 2026-10-27 -> 10/27/26
  const [year, month, day] = text.split("-");
  return month + "/" + day + "/" + year.slice(2);
}

function formatTime(text) {    // 13:30 -> 1:30 PM
  const [hour, minute] = text.split(":").map(Number);
  return ((hour + 11) % 12 + 1) + ":" + String(minute).padStart(2, "0") + " " + (hour < 12 ? "AM" : "PM");
}

function scheduleText(course) {
  const days = course.days.map((d) => DAY_NAMES[d]).join(" ");
  const time = course.start ? formatTime(course.start) + " - " + formatTime(course.end) : "";
  return [days, time].filter(Boolean).join(", ");
}

// so names like <b> or "quotes" don't break the page
function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const statusLabel = (status) => status[0].toUpperCase() + status.slice(1);
const byProgramBlock = (a, b) => a.program.localeCompare(b.program) || a.block.localeCompare(b.block);

// a small message; if "undo" is given the message gets an Undo button
function showToast(message, isError, undo) {
  const toast = document.createElement("div");
  toast.className = "toast" + (isError ? " error" : "");
  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);
  if (undo) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-undo";
    button.textContent = "Undo";
    button.addEventListener("click", () => { toast.remove(); undo(); });
    toast.appendChild(button);
  }
  $("toasts").appendChild(toast);
  setTimeout(() => toast.remove(), undo ? 9000 : 3500);
}

function openModal(id) {
  focusBeforeModal = document.activeElement;
  $(id).hidden = false;
}

function closeOverlay(overlay) {
  if (overlay.hidden) return;
  overlay.hidden = true;
  if (focusBeforeModal && document.body.contains(focusBeforeModal)) focusBeforeModal.focus();
}

function closeModal(id) {
  closeOverlay($(id));
}

// shows the "are you sure?" box. "action" runs if the professor clicks Yes
function askConfirm(title, message, buttonText, action) {
  $("confirmTitle").textContent = title;
  $("confirmMessage").textContent = message;
  $("confirmYes").textContent = buttonText;
  onConfirm = action;
  openModal("confirmModal");
}


// ===================== saving, loading and Undo =====================

function persistData() {
  if (AUTH) {
    const snapshot = JSON.parse(JSON.stringify(store.toData()));
    cloudSaveQueue = cloudSaveQueue
      .catch(() => {})
      .then(() => AUTH.saveWorkspace(snapshot))
      .catch((err) => showToast("Cloud save failed: " + err.message, true));
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store.toData()));
  } catch (err) {
    showToast("Your browser could not save the changes. Check your storage settings.", true);
  }
}

async function loadData() {
  if (AUTH) {
    const saved = await AUTH.loadWorkspace();
    if (saved === null) {
      const startWithSample = AUTH.currentUser().metadata.start_with_sample !== false;
      const initial = startWithSample
        ? JSON.parse(JSON.stringify(SAMPLE_DATA))
        : { courses: [], students: [], enrollments: [], sheets: [], counters: {} };
      store.replaceAll(initial);
      await AUTH.saveWorkspace(store.toData());
    } else {
      if (!Data.isValidData(saved)) throw new Error("The cloud workspace has an invalid data format.");
      store.replaceAll(saved);
    }
    selectedCourseId = courses.length ? courses[0].id : null;
    resetMarks();
    return;
  }

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (err) { saved = null; }
  const usable = Data.isValidData(saved);
  store.replaceAll(usable ? saved : JSON.parse(JSON.stringify(SAMPLE_DATA)));
  if (!usable) persistData();
  selectedCourseId = courses.length ? courses[0].id : null;
  resetMarks();
}

function refresh() {
  if (!getCourse()) { selectedCourseId = courses.length ? courses[0].id : null; resetMarks(); }
  persistData();
  renderAll();
}

// Runs a change to the data, saves it, redraws the screen and shows a message.
// "message" can be text or a function that returns text. With canUndo the message gets an Undo button.
// Returns true when the change worked, so pop-ups only close after a good save.
function applyChange(message, change, canUndo) {
  const before = store.snapshot();
  const marksBefore = marks;
  try {
    change();
  } catch (err) {
    store.restore(before);
    showToast(err.message, true);
    return false;
  }
  refresh();
  const undo = () => { store.restore(before); marks = marksBefore; refresh(); showToast("Undone."); };
  showToast(typeof message === "function" ? message() : message, false, canUndo ? undo : null);
  return true;
}

function getCourse() { return courses.find((c) => c.id === selectedCourseId); }

function sortByName(list, az) {
  return list.slice().sort((a, b) => (a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)) * (az ? 1 : -1));
}

function searchStudents(list, text) {
  text = text.trim().toLowerCase();
  return list.filter((s) => (s.lastName + " " + s.firstName + " " + s.studentNumber).toLowerCase().includes(text));
}


// ===================== Program / Course / Block dropdowns =====================

function fillSelect(selector, options, value) {
  document.querySelectorAll(selector).forEach((select) => {
    select.innerHTML = options.join("") || "<option value=''>None yet</option>";
    select.value = value;
  });
}

function fillOptions(select, values, allText, current) {
  select.innerHTML = `<option value="all">${allText}</option>` + values.map((v) => `<option>${escapeHtml(v)}</option>`).join("");
  select.value = current;
}

function fillFilters() {
  const course = getCourse();
  const programs = [...new Set(courses.map((c) => c.program))].sort();
  const names = course ? [...new Set(courses.filter((c) => c.program === course.program).map((c) => c.name))].sort() : [];
  const blocks = course ? courses.filter((c) => c.program === course.program && c.name === course.name) : [];

  fillSelect(".program-select", programs.map((p) => `<option>${escapeHtml(p)}</option>`), course ? course.program : "");
  fillSelect(".course-select", names.map((n) => `<option>${escapeHtml(n)}</option>`), course ? course.name : "");
  fillSelect(".block-select", blocks.map((c) => `<option value="${c.id}">${escapeHtml(c.block)}</option>`), course ? course.id : "");
}

// when any of the 3 dropdowns changes, find the matching course
document.addEventListener("change", (e) => {
  const select = e.target;
  const course = getCourse();
  let found = null;

  if (select.matches(".program-select")) found = courses.find((c) => c.program === select.value);
  else if (select.matches(".course-select") && course) found = courses.find((c) => c.program === course.program && c.name === select.value);
  else if (select.matches(".block-select")) found = courses.find((c) => c.id === Number(select.value));
  else return;

  if (!found) return;
  confirmIfUnsaved(() => {
    selectedCourseId = found.id;
    resetMarks();
    $("attSearch").value = "";
    $("clSearch").value = "";
    renderAll();
  });
  renderAll();   // keeps the dropdowns on the old class until the change is confirmed
});


// ===================== ATTENDANCE PAGE =====================

// asks first when there are unsaved marks, then runs "next"
function confirmIfUnsaved(next) {
  if (!unsaved) return next();
  askConfirm("Unsaved changes", "You have attendance marks that are not saved yet. Discard them?", "Discard", next);
}

function resetMarks() {
  marks = {};
  unsaved = false;
}

// makes sure every student has a mark. Marks already picked are kept.
function syncMarks() {
  const course = getCourse();
  const saved = course ? store.findSheet(course.id, attendanceDate) : null;
  const newMarks = {};

  (course ? store.studentsOf(course.id) : []).forEach((s) => {
    const record = saved ? saved.records.find((r) => r.studentId === s.id) : null;
    newMarks[s.id] = marks[s.id] || (record ? record.status : "present");
  });
  marks = newMarks;
}

function statusOptions(current) {
  return Data.STATUSES.map((status) => `<option value="${status}"${status === current ? " selected" : ""}>${statusLabel(status)}</option>`).join("");
}

// the classes that meet on the picked date (from the schedule) plus any class that already has a sheet that day
function renderToday() {
  const weekday = new Date(attendanceDate + "T00:00:00").getDay();
  const list = courses.filter((c) => c.days.includes(weekday) || store.findSheet(c.id, attendanceDate)).sort(byProgramBlock);
  const done = list.filter((c) => store.findSheet(c.id, attendanceDate)).length;

  $("todayTitle").textContent = attendanceDate === getToday() ? "Today's classes" : "Classes on " + longDate(attendanceDate);
  $("todaySub").textContent = list.length ? list.length + " class(es), " + done + " saved" : "No classes scheduled";
  $("todayChips").innerHTML = list.length ? list.map((c) => {
    const sheet = store.findSheet(c.id, attendanceDate);
    const counts = sheet ? Data.countStatuses(sheet.records.map((r) => r.status)) : null;
    const state = sheet ? "Saved: " + (counts.present + counts.late) + " of " + sheet.records.length + " attended" : "Not taken yet";
    return `<button type="button" class="class-chip${c.id === selectedCourseId ? " current" : ""}${sheet ? " done" : ""}" data-course="${c.id}">
      <strong>${escapeHtml(c.block)}</strong><span>${escapeHtml(c.code)} ${c.start ? formatTime(c.start) : ""}</span><small>${state}</small></button>`;
  }).join("") : `<p class="muted chips-empty">Nothing is scheduled for this day. Add meeting days in Class List > Edit Course.</p>`;
}

function renderAttendanceStats() {
  const course = getCourse();
  const counts = Data.countStatuses(Object.values(marks));
  $("statSize").textContent = Object.keys(marks).length;
  $("statPresent").textContent = counts.present;
  $("statLate").textContent = counts.late;
  $("statExcused").textContent = counts.excused;
  $("statAbsent").textContent = counts.absent;

  const saved = course && store.findSheet(course.id, attendanceDate);
  const future = attendanceDate > getToday();
  $("sheetPill").textContent = unsaved ? "Unsaved changes" : saved ? "Saved sheet" : future ? "Future date" : "New sheet";
  $("sheetPill").className = "pill " + (unsaved || (future && !saved) ? "warn" : saved ? "ok" : "");
}

function renderAttendance() {
  const course = getCourse();
  const list = course ? store.studentsOf(course.id) : [];
  const shown = sortByName(searchStudents(list, $("attSearch").value), sortAZ.attendance);

  $("attDate").value = attendanceDate;
  $("attSubtitle").textContent = course ? course.block + " | " + course.name + " | " + longDate(attendanceDate) : "No course yet";
  $("attSort").textContent = sortAZ.attendance ? "Surnames A to Z" : "Surnames Z to A";
  renderToday();

  if (shown.length === 0) {
    let message = "No course yet. Go to Class List and click New Course.";
    if (course) message = list.length ? "No student matches your search." : "No students yet. Click Add Student to start your class list.";
    $("attBody").innerHTML = `<tr><td class="empty" colspan="2">${message}</td></tr>`;
  } else {
    $("attBody").innerHTML = shown.map((s) => {
      const absences = store.statsFor(s.id, course.id).absent;
      const warning = absences >= Data.ABSENCE_WARNING ? ` <span class="warn-badge" title="Absent ${absences} times in saved sheets">${absences} absences</span>` : "";
      return `
      <tr>
        <td>${escapeHtml(s.studentNumber)}</td>
        <td class="name">${escapeHtml(s.lastName)}, ${escapeHtml(s.firstName)}${warning}</td>
        <td>
          <span class="select-box status-box status-${marks[s.id]}">
            <select class="status-select" data-id="${s.id}" aria-label="Status of ${escapeHtml(s.firstName + " " + s.lastName)}">${statusOptions(marks[s.id])}</select>
          </span>
        </td>
      </tr>`;
    }).join("");
  }
  renderAttendanceStats();
}

function saveAttendance(skipFutureCheck) {
  const course = getCourse();
  if (!course) return showToast("Create a course first.", true);
  const list = store.studentsOf(course.id);
  if (list.length === 0) return showToast("Add students to this class first.", true);
  if (attendanceDate > getToday() && skipFutureCheck !== true) {
    return askConfirm("Future date", longDate(attendanceDate) + " has not happened yet. Save this attendance sheet anyway?", "Save anyway", () => saveAttendance(true));
  }

  let updated = false;
  const records = list.map((s) => ({ studentId: s.id, status: marks[s.id] }));
  const worked = applyChange(() => updated ? "Attendance sheet updated." : "Attendance sheet saved.", () => {
    updated = store.saveSheet(course.id, attendanceDate, records).updated;
    unsaved = false;
  });
  return worked;
}


// ===================== CLASS LIST PAGE =====================

function renderClassList() {
  const course = getCourse();
  const list = course ? store.studentsOf(course.id) : [];
  const shown = sortByName(searchStudents(list, $("clSearch").value), sortAZ.classlist);

  $("clSubtitle").textContent = course ? course.program + " | " + course.block + " | " + list.length + " students" : "No course yet";
  $("clSchedule").textContent = course ? (scheduleText(course) || "No schedule yet. Click Edit Course to add meeting days and times.") : "";
  $("clSort").textContent = sortAZ.classlist ? "Surnames A to Z" : "Surnames Z to A";

  if (shown.length === 0) {
    let message = "No course yet. Click New Course to make one.";
    if (course) message = list.length ? "No student matches your search." : "No students yet. Click Add Student or Upload Excel.";
    $("clBody").innerHTML = `<tr><td class="empty" colspan="4">${message}</td></tr>`;
    return;
  }

  $("clBody").innerHTML = shown.map((s) => {
    const stats = store.statsFor(s.id, course.id);
    const rate = Data.attendanceRate(stats);
    const flagged = stats.absent >= Data.ABSENCE_WARNING;
    const text = rate === null ? "No records yet" : rate + "% attended, " + stats.absent + " absent" + (stats.excused ? ", " + stats.excused + " excused" : "");
    return `
    <tr>
      <td>${escapeHtml(s.studentNumber)}</td>
      <td class="name">${escapeHtml(s.lastName)}, ${escapeHtml(s.firstName)}</td>
      <td>${escapeHtml(text)}${flagged ? ' <span class="warn-badge">Needs attention</span>' : ""}</td>
      <td class="actions">
        <button class="btn small outline danger" data-action="remove" data-id="${s.id}">Remove</button>
        <button class="btn small outline gray" data-action="edit" data-id="${s.id}">Edit</button>
      </td>
    </tr>`;
  }).join("");
}

function openStudentModal(student) {
  const course = getCourse();
  if (!course) return showToast("Create a course first (Class List > New Course).", true);

  editingStudentId = student ? student.id : null;
  $("studentTitle").textContent = student ? "Edit Student" : "Add Student";
  $("studentFor").textContent = course.block + " | " + course.name;
  $("studentNote").textContent = student ? "Changes here apply to this student in every class." : "If this student ID already exists in another class, the same student is added to this class.";
  $("stNumber").value = student ? student.studentNumber : "";
  $("stLast").value = student ? student.lastName : "";
  $("stFirst").value = student ? student.firstName : "";
  openModal("studentModal");
  $("stNumber").focus();
}

function openCourseModal(course) {
  editingCourse = Boolean(course);
  $("courseTitle").textContent = course ? "Edit Course" : "New Course";
  $("crProgram").value = course ? course.program : "";
  $("crName").value = course ? course.name : "";
  $("crCode").value = course ? course.code : "";
  $("crBlock").value = course ? course.block : "";
  $("crStart").value = course ? course.start : "";
  $("crEnd").value = course ? course.end : "";
  document.querySelectorAll("[name=crDay]").forEach((box) => { box.checked = Boolean(course) && course.days.includes(Number(box.value)); });
  openModal("courseModal");
  $("crProgram").focus();
}


// ===================== Upload Excel =====================

async function importRows(rows) {
  const course = getCourse();
  if (!course) return showToast("Create a course first.", true);

  let result = { added: 0, skipped: 0 };
  closeModal("uploadModal");
  $("uploadFile").value = "";
  applyChange(() => {
    let message = result.added + " student(s) added";
    if (result.skipped) message += ", " + result.skipped + " skipped (duplicate or incomplete)";
    return message + ".";
  }, () => { result = store.importStudents(course.id, rows); }, true);
}


// ===================== SAVED SHEETS PAGE =====================

// Program > Course > Block, each list only shows what fits the choice before it
function fillSheetFilters() {
  const programs = [...new Set(courses.map((c) => c.program))].sort();
  if (!programs.includes(sheetFilter.program)) sheetFilter.program = "all";
  const inProgram = courses.filter((c) => sheetFilter.program === "all" || c.program === sheetFilter.program);
  const names = [...new Set(inProgram.map((c) => c.name))].sort();
  if (!names.includes(sheetFilter.course)) sheetFilter.course = "all";
  const inCourse = inProgram.filter((c) => sheetFilter.course === "all" || c.name === sheetFilter.course);
  const blocks = [...new Set(inCourse.map((c) => c.block))].sort();
  if (!blocks.includes(sheetFilter.block)) sheetFilter.block = "all";
  fillOptions($("shProgram"), programs, "All programs", sheetFilter.program);
  fillOptions($("shCourse"), names, "All courses", sheetFilter.course);
  fillOptions($("shBlock"), blocks, "All blocks", sheetFilter.block);
}

function fitsSheetFilter(course) {
  return (sheetFilter.program === "all" || course.program === sheetFilter.program) &&
         (sheetFilter.course === "all" || course.name === sheetFilter.course) &&
         (sheetFilter.block === "all" || course.block === sheetFilter.block);
}

function renderSheets() {
  fillSheetFilters();
  const text = $("shSearch").value.trim().toLowerCase();
  const from = $("shFrom").value;
  const to = $("shTo").value;
  const list = sheets
    .filter((s) => store.courseById(s.courseId) && fitsSheetFilter(store.courseById(s.courseId)))
    .filter((s) => (!from || s.date >= from) && (!to || s.date <= to))
    .filter((s) => {
      const c = store.courseById(s.courseId);
      return (shortDate(s.date) + " " + longDate(s.date) + " " + s.date + " " + c.program + " " + c.block + " " + c.code + " " + c.name).toLowerCase().includes(text);
    });

  // sort by date (default) or by program, then block, then date
  list.sort((a, b) => {
    const ca = store.courseById(a.courseId), cb = store.courseById(b.courseId);
    const byDate = a.date.localeCompare(b.date) * (oldestFirst.sheets ? 1 : -1);
    if (!sheetsByBlock) return byDate || ca.block.localeCompare(cb.block);
    return byProgramBlock(ca, cb) || byDate;
  });

  const range = from || to ? (from ? longDate(from) : "the start") + " to " + (to ? longDate(to) : "now") + " | " : "";
  $("shSubtitle").textContent = range + list.length + " class sheet(s)";
  $("shSort").textContent = oldestFirst.sheets ? "Date: oldest first" : "Date: newest first";
  $("shSort").classList.toggle("active", !sheetsByBlock);
  $("shSortBlock").classList.toggle("active", sheetsByBlock);

  if (list.length === 0) {
    $("shBody").innerHTML = `<tr><td class="empty" colspan="9">${text || from || to || sheetFilter.program !== "all" ? "No sheet matches your filters." : "No saved sheets yet."}</td></tr>`;
    return;
  }

  let lastGroup = "";
  $("shBody").innerHTML = list.map((sheet) => {
    const course = store.courseById(sheet.courseId);
    const c = Data.countStatuses(sheet.records.map((r) => r.status));
    // a heading row for every new date (or program) so all classes of that day sit together
    const group = sheetsByBlock ? course.program : longDate(sheet.date);
    let heading = "";
    if (group !== lastGroup) { heading = `<tr class="group-row"><td colspan="9">${escapeHtml(group)}</td></tr>`; lastGroup = group; }
    return heading + `
      <tr>
        <td>${shortDate(sheet.date)}</td>
        <td class="name">${escapeHtml(course.code)}</td>
        <td>${escapeHtml(course.program)} / ${escapeHtml(course.block)}</td>
        <td>${sheet.records.length}</td>
        <td>${c.present}</td>
        <td>${c.late}</td>
        <td>${c.excused}</td>
        <td>${c.absent}</td>
        <td class="actions">
          <button class="btn small" data-action="edit" data-id="${sheet.id}">Edit</button>
          <button class="btn small outline gray" data-action="print" data-id="${sheet.id}">Print</button>
          <button class="btn small outline gray" data-action="csv" data-id="${sheet.id}">CSV</button>
          <button class="btn small outline danger" data-action="delete" data-id="${sheet.id}">Delete</button>
        </td>
      </tr>`;
  }).join("");
}

function downloadFile(blob, name) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// downloads one sheet as a .csv file (opens in Excel)
function downloadCsv(sheet) {
  const course = store.courseById(sheet.courseId);
  const quote = (value) => {
    let text = String(value);
    if (/^[=+\-@]/.test(text)) text = "'" + text;     // cells starting with = + - @ could run as formulas
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const lines = ["Student ID,Last Name,First Name,Date,Status"];

  sheet.records.forEach((r) => {
    const s = students.find((st) => st.id === r.studentId);
    if (s) lines.push([s.studentNumber, s.lastName, s.firstName, sheet.date, statusLabel(r.status)].map(quote).join(","));
  });

  downloadFile(new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv" }), "attendance_" + course.code + "_" + course.block.replace(/ /g, "") + "_" + sheet.date + ".csv");
  showToast("CSV downloaded.");
}

// fills the hidden print page and opens the print box (choose "Save as PDF" there to make a PDF)
function printSheet(sheet) {
  const course = store.courseById(sheet.courseId);
  const people = sortByName(sheet.records.map((r) => students.find((s) => s.id === r.studentId)).filter(Boolean), true);
  const counts = Data.countStatuses(sheet.records.map((r) => r.status));
  const rows = people.map((s, i) => {
    const record = sheet.records.find((r) => r.studentId === s.id);
    return `<tr><td>${i + 1}</td><td>${escapeHtml(s.studentNumber)}</td><td>${escapeHtml(s.lastName)}, ${escapeHtml(s.firstName)}</td><td>${statusLabel(record.status)}</td></tr>`;
  }).join("");
  $("printArea").innerHTML = `
    <h1>AttendEase attendance sheet</h1>
    <p><strong>${escapeHtml(course.name)}</strong> (${escapeHtml(course.code)}) | ${escapeHtml(course.program)} ${escapeHtml(course.block)}<br>${longDate(sheet.date)}</p>
    <table><thead><tr><th>No.</th><th>Student ID</th><th>Name</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    <p>Present: ${counts.present} | Late: ${counts.late} | Excused: ${counts.excused} | Absent: ${counts.absent}</p>`;
  window.print();
}

// one .xlsx file with every saved sheet: one row per student per class day
function downloadAllSheets() {
  if (sheets.length === 0) return showToast("There are no saved sheets to download yet.", true);
  const rows = [["Date", "Program", "Course code", "Course", "Block", "Student ID", "Last name", "First name", "Status"]];
  const ordered = sheets.slice().sort((a, b) => a.date.localeCompare(b.date) || byProgramBlock(store.courseById(a.courseId), store.courseById(b.courseId)));
  ordered.forEach((sheet) => {
    const course = store.courseById(sheet.courseId);
    sheet.records.forEach((r) => {
      const s = students.find((st) => st.id === r.studentId);
      if (course && s) rows.push([sheet.date, course.program, course.code, course.name, course.block, s.studentNumber, s.lastName, s.firstName, statusLabel(r.status)]);
    });
  });
  const type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  downloadFile(new Blob([Data.buildXlsx(rows, "Attendance")], { type }), "attendease-all-sheets-" + getToday() + ".xlsx");
  showToast("Excel file downloaded (" + (rows.length - 1) + " rows).");
}

// ----- edit by date range: change one student's status on every saved sheet between two dates -----
function rangeOptions() {
  return {
    studentId: Number($("rgStudent").value), from: $("rgFrom").value, to: $("rgTo").value, status: $("rgStatus").value,
    courseIds: courses.filter(fitsSheetFilter).map((c) => c.id)      // only the classes picked in the filters
  };
}

function updateRangePreview() {
  const o = rangeOptions();
  let text = "Pick both dates to see how many records will change.";
  if (o.studentId && o.from && o.to && o.from <= o.to) {
    const count = store.findInRange(o).length;
    text = count + " record(s) will change to " + statusLabel(o.status).toLowerCase() + ".";
  }
  $("rgPreview").textContent = text;
}

function openRangeModal() {
  const ids = new Set();
  courses.filter(fitsSheetFilter).forEach((c) => store.studentsOf(c.id).forEach((s) => ids.add(s.id)));
  const people = sortByName(students.filter((s) => ids.has(s.id)), true);
  if (people.length === 0) return showToast("There are no students in the classes you are filtering.", true);
  $("rgStudent").innerHTML = people.map((s) => `<option value="${s.id}">${escapeHtml(s.lastName + ", " + s.firstName)} (${escapeHtml(s.studentNumber)})</option>`).join("");
  $("rgStatus").innerHTML = statusOptions("excused");
  $("rgFrom").value = $("shFrom").value;
  $("rgTo").value = $("shTo").value;
  updateRangePreview();
  openModal("rangeModal");
}


// ===================== STUDENT PREVIEW PAGE =====================

function renderPreview() {
  // Program and Block dropdowns narrow down the student list
  const programs = [...new Set(courses.map((c) => c.program))].sort();
  if (previewProgram !== "all" && !programs.includes(previewProgram)) previewProgram = "all";
  const blocks = [...new Set(courses.filter((c) => previewProgram === "all" || c.program === previewProgram).map((c) => c.block))].sort();
  if (previewBlock !== "all" && !blocks.includes(previewBlock)) previewBlock = "all";
  fillOptions($("pvProgram"), programs, "All programs", previewProgram);
  fillOptions($("pvBlock"), blocks, "All blocks", previewBlock);

  // each student appears once, under the first class that fits the filters
  const entries = [];
  students.forEach((st) => {
    const fits = store.coursesOf(st.id).filter((c) => (previewProgram === "all" || c.program === previewProgram) && (previewBlock === "all" || c.block === previewBlock)).sort(byProgramBlock);
    if (fits.length) entries.push({ student: st, course: fits[0] });
  });
  entries.sort((a, b) => byProgramBlock(a.course, b.course) || a.student.lastName.localeCompare(b.student.lastName) || a.student.firstName.localeCompare(b.student.firstName));

  if (!entries.some((e) => e.student.studentNumber === previewNumber)) previewNumber = entries.length ? entries[0].student.studentNumber : "";

  // students are grouped like: BSCS - BSCS 1A > names
  let nameHtml = "";
  let openGroup = "";
  entries.forEach((e) => {
    const group = e.course.program + " - " + e.course.block;
    if (group !== openGroup) { nameHtml += (openGroup ? "</optgroup>" : "") + `<optgroup label="${escapeHtml(group)}">`; openGroup = group; }
    nameHtml += `<option value="${escapeHtml(e.student.studentNumber)}">${escapeHtml(e.student.lastName + ", " + e.student.firstName)} (${escapeHtml(e.student.studentNumber)})</option>`;
  });
  $("pvName").innerHTML = nameHtml ? nameHtml + "</optgroup>" : "<option value=''>No students yet</option>";
  $("pvName").value = previewNumber;

  // course codes of this student
  const me = students.find((s) => s.studentNumber === previewNumber);
  const mine = me ? store.coursesOf(me.id) : [];
  const codes = [...new Set(mine.map((c) => c.code))].sort();
  const stillValid = previewCode === "all" ? codes.length > 1 : codes.includes(previewCode);
  if (!stillValid) previewCode = codes[0] || "";

  let options = codes.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if (codes.length > 1) options += "<option value='all'>All courses</option>";
  $("pvCode").innerHTML = options || "<option value=''>None</option>";
  $("pvCode").value = previewCode;

  // one row for every saved sheet that has this student
  const rows = [];
  mine.filter((c) => previewCode === "all" || c.code === previewCode).forEach((course) => {
    sheets.filter((sh) => sh.courseId === course.id).forEach((sh) => {
      const record = sh.records.find((r) => r.studentId === me.id);
      if (record) rows.push({ date: sh.date, course: course, status: record.status });
    });
  });

  const counts = Data.countStatuses(rows.map((r) => r.status));
  const rate = Data.attendanceRate(counts);
  $("pvSize").textContent = rows.length;
  $("pvPresent").textContent = counts.present;
  $("pvLate").textContent = counts.late;
  $("pvExcused").textContent = counts.excused;
  $("pvAbsent").textContent = counts.absent;
  $("pvRate").textContent = rate === null ? "-" : rate + "%";
  $("pvRateCard").classList.toggle("flagged", counts.absent >= Data.ABSENCE_WARNING);
  $("pvRateNote").textContent = counts.absent >= Data.ABSENCE_WARNING ? "Needs attention: " + counts.absent + " absences" : "Present and late days";

  const names = [...new Set(rows.map((r) => r.course.block + " | " + r.course.name))];
  $("pvSubtitle").textContent = names.length === 1 ? names[0] : names.length ? "All courses" : "No records yet";
  $("pvSort").textContent = oldestFirst.preview ? "Date: oldest first" : "Date: newest first";

  const text = $("pvSearch").value.trim().toLowerCase();
  const shown = rows
    .filter((r) => (shortDate(r.date) + " " + longDate(r.date) + " " + r.date + " " + r.course.name + " " + r.course.code).toLowerCase().includes(text))
    .sort((a, b) => a.date.localeCompare(b.date) * (oldestFirst.preview ? 1 : -1));

  if (shown.length === 0) {
    $("pvBody").innerHTML = `<tr><td class="empty" colspan="4">${text ? "No record matches your search." : "No attendance records yet."}</td></tr>`;
    return;
  }

  $("pvBody").innerHTML = shown.map((r) => `
    <tr>
      <td>${longDate(r.date)}</td>
      <td class="name">${escapeHtml(r.course.name)}</td>
      <td>${escapeHtml(r.course.block)}</td>
      <td><span class="badge status-${r.status}">${statusLabel(r.status)}</span></td>
    </tr>`).join("");
}


// ===================== SETTINGS: backup =====================

function exportBackup() {
  const backup = Object.assign({ app: "AttendEase", version: 3, exportedAt: new Date().toISOString() }, store.toData());
  downloadFile(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }), "attendease-backup-" + getToday() + ".json");
  showToast("Backup downloaded.");
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onerror = () => showToast("Could not read that file.", true);
  reader.onload = () => {
    let backup = null;
    try { backup = JSON.parse(reader.result); } catch (err) { backup = null; }
    if (!Data.isValidData(backup)) return showToast("That is not a valid AttendEase backup file.", true);
    askConfirm("Restore backup", "This replaces your current data with the backup (" + backup.courses.length + " courses, " + backup.sheets.length + " sheets).", "Restore", () => {
      applyChange("Backup restored.", () => { store.replaceAll(backup); selectedCourseId = null; }, true);
    });
  };
  reader.readAsText(file);
}


// ===================== showing pages =====================

function showPage(name) {
  document.querySelectorAll(".page").forEach((page) => {
    page.hidden = page.id !== "page-" + name;
    if (!page.hidden) {
      page.classList.remove("page-entering");
      void page.offsetWidth;
      page.classList.add("page-entering");
    }
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === name);
  });
  $("pageTitle").textContent = TITLES[name];
}

function renderAll() {
  syncMarks();
  fillFilters();
  renderAttendance();
  renderClassList();
  renderSheets();
  renderPreview();
}


// ===================== buttons and events =====================

function setupEvents() {
  document.querySelectorAll(".course-filters").forEach((box) => { box.innerHTML = filterHtml; });

  // ----- sidebar -----
  const navToggle = $("mobileNavToggle");
  const sidebar = $("workspaceSidebar");
  const navBackdrop = $("mobileNavBackdrop");
  const setMobileNavOpen = (open) => {
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    sidebar.classList.toggle("nav-open", open);
    navBackdrop.hidden = !open;
  };
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      showPage(button.dataset.page);
      setMobileNavOpen(false);
    });
  });
  navToggle.addEventListener("click", () => {
    setMobileNavOpen(navToggle.getAttribute("aria-expanded") !== "true");
  });
  navBackdrop.addEventListener("click", () => setMobileNavOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setMobileNavOpen(false);
  });
  $("brand").addEventListener("click", () => {
    showPage("attendance");
    setMobileNavOpen(false);
  });
  $("profileBtn").addEventListener("click", () => {
    showPage("settings");
    setMobileNavOpen(false);
  });

  // ----- pop-up boxes: Cancel buttons, clicking outside, Esc key, Tab stays inside -----
  document.querySelectorAll(".overlay .modal").forEach((modal, i) => {   // screen readers: these are dialogs
    const title = modal.querySelector("h3");
    title.id = title.id || "modalTitle" + i;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", title.id);
  });
  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => closeOverlay(button.closest(".overlay")));
  });
  document.querySelectorAll(".overlay").forEach((overlay) => {
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeOverlay(overlay); });
  });
  document.addEventListener("keydown", (e) => {
    const overlay = document.querySelector(".overlay:not([hidden])");
    if (!overlay) return;
    if (e.key === "Escape") closeOverlay(overlay);
    if (e.key === "Tab") {
      const items = [...overlay.querySelectorAll("button, input, select, [href]")].filter((el) => !el.disabled && !el.classList.contains("dd-native") && el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  $("confirmYes").addEventListener("click", () => {
    closeModal("confirmModal");
    try { onConfirm(); } catch (err) { showToast(err.message, true); }
  });

  // ----- attendance page -----
  $("attDate").addEventListener("change", (e) => {
    const picked = e.target.value || attendanceDate;
    confirmIfUnsaved(() => { attendanceDate = picked; resetMarks(); renderAll(); });
    renderAttendance();   // puts the old date back in the box until the change is confirmed
  });
  $("todayBtn").addEventListener("click", () => {
    confirmIfUnsaved(() => { attendanceDate = getToday(); resetMarks(); renderAll(); });
  });
  $("todayChips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-course]");
    if (!chip || Number(chip.dataset.course) === selectedCourseId) return;
    confirmIfUnsaved(() => { selectedCourseId = Number(chip.dataset.course); resetMarks(); renderAll(); });
  });
  $("attSearch").addEventListener("input", renderAttendance);
  $("attAddBtn").addEventListener("click", () => openStudentModal(null));
  $("attSort").addEventListener("click", () => { sortAZ.attendance = !sortAZ.attendance; renderAttendance(); });

  $("attBody").addEventListener("change", (e) => {
    if (!e.target.matches(".status-select")) return;
    marks[e.target.dataset.id] = e.target.value;
    e.target.closest(".select-box").className = "select-box status-box status-" + e.target.value;
    unsaved = true;
    renderAttendanceStats();
  });

  $("markAllBtn").addEventListener("click", () => {
    if (Object.keys(marks).length === 0) return showToast("There are no students to mark.", true);
    const marksBefore = Object.assign({}, marks);
    const unsavedBefore = unsaved;
    Object.keys(marks).forEach((id) => { marks[id] = "present"; });
    unsaved = true;
    renderAttendance();
    showToast("Everyone is marked present. Click Save/Update to keep it.", false, () => { marks = marksBefore; unsaved = unsavedBefore; renderAttendance(); });
  });
  $("saveBtn").addEventListener("click", () => saveAttendance());

  // ----- class list page -----
  $("clSearch").addEventListener("input", renderClassList);
  $("clSort").addEventListener("click", () => { sortAZ.classlist = !sortAZ.classlist; renderClassList(); });
  $("clAddBtn").addEventListener("click", () => openStudentModal(null));
  $("newCourseBtn").addEventListener("click", () => openCourseModal(null));
  $("uploadBtn").addEventListener("click", () => {
    if (!getCourse()) return showToast("Create a course first.", true);
    openModal("uploadModal");
  });
  $("editCourseBtn").addEventListener("click", () => {
    if (!getCourse()) return showToast("There is no course to edit.", true);
    openCourseModal(getCourse());
  });
  $("deleteCourseBtn").addEventListener("click", () => {
    const course = getCourse();
    if (!course) return showToast("There is no course to delete.", true);
    askConfirm("Delete course", `Delete ${course.name} (${course.block})? Its class list and attendance sheets will be deleted too. You can undo this right after.`, "Delete", () => {
      applyChange("Course deleted.", () => store.deleteCourse(course.id), true);
    });
  });

  // Remove / Edit buttons inside the class list table
  $("clBody").addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    const student = students.find((s) => s.id === Number(button.dataset.id));
    if (button.dataset.action === "edit") openStudentModal(student);
    if (button.dataset.action === "remove") {
      applyChange(student.firstName + " " + student.lastName + " removed from this class.", () => store.removeStudent(selectedCourseId, student.id), true);
    }
  });

  // add / edit student form
  $("studentForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const body = { studentNumber: $("stNumber").value, lastName: $("stLast").value, firstName: $("stFirst").value };
    const editing = editingStudentId !== null;
    const worked = applyChange(editing ? "Student updated." : "Student added.", () => {
      if (editing) store.updateStudent(editingStudentId, body);
      else store.addStudent(selectedCourseId, body);
    });
    if (worked) closeModal("studentModal");
  });

  // new / edit course form
  $("courseForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const body = {
      program: $("crProgram").value, name: $("crName").value, code: $("crCode").value, block: $("crBlock").value,
      start: $("crStart").value, end: $("crEnd").value,
      days: [...document.querySelectorAll("[name=crDay]:checked")].map((box) => box.value)
    };
    const worked = applyChange(editingCourse ? "Course updated." : "Course created.", () => {
      if (editingCourse) store.updateCourse(selectedCourseId, body);
      else { selectedCourseId = store.addCourse(body).id; resetMarks(); }
    });
    if (worked) closeModal("courseModal");
  });

  // upload excel form
  $("uploadForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const file = $("uploadFile").files[0];
    if (!file) return showToast("Please choose a file first.", true);
    readRows(file, importRows);
  });

  // ----- saved sheets page -----
  $("shSearch").addEventListener("input", renderSheets);
  $("shSort").addEventListener("click", () => { oldestFirst.sheets = sheetsByBlock ? oldestFirst.sheets : !oldestFirst.sheets; sheetsByBlock = false; renderSheets(); });
  $("shSortBlock").addEventListener("click", () => { sheetsByBlock = true; renderSheets(); });
  $("shFrom").addEventListener("change", () => { if ($("shTo").value && $("shFrom").value > $("shTo").value) $("shTo").value = $("shFrom").value; renderSheets(); });
  $("shTo").addEventListener("change", () => { if ($("shFrom").value && $("shFrom").value > $("shTo").value) $("shFrom").value = $("shTo").value; renderSheets(); });
  $("shProgram").addEventListener("change", (e) => { sheetFilter = { program: e.target.value, course: "all", block: "all" }; renderSheets(); });
  $("shCourse").addEventListener("change", (e) => { sheetFilter.course = e.target.value; sheetFilter.block = "all"; renderSheets(); });
  $("shBlock").addEventListener("change", (e) => { sheetFilter.block = e.target.value; renderSheets(); });
  $("exportAllBtn").addEventListener("click", downloadAllSheets);
  $("rangeBtn").addEventListener("click", openRangeModal);
  ["rgStudent", "rgFrom", "rgTo", "rgStatus"].forEach((id) => $(id).addEventListener("change", updateRangePreview));
  $("rangeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    let count = 0;
    const worked = applyChange(() => count + " record(s) updated.", () => { count = store.setStatusInRange(rangeOptions()); }, true);
    if (worked) closeModal("rangeModal");
  });

  $("shBody").addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    const sheet = sheets.find((s) => s.id === Number(button.dataset.id));

    if (button.dataset.action === "edit") {
      confirmIfUnsaved(() => { selectedCourseId = sheet.courseId; attendanceDate = sheet.date; resetMarks(); renderAll(); showPage("attendance"); });
    }
    if (button.dataset.action === "csv") downloadCsv(sheet);
    if (button.dataset.action === "print") printSheet(sheet);
    if (button.dataset.action === "delete") applyChange("Sheet for " + longDate(sheet.date) + " deleted.", () => store.deleteSheet(sheet.id), true);
  });

  // ----- student preview page -----
  $("pvProgram").addEventListener("change", (e) => { previewProgram = e.target.value; previewBlock = "all"; renderPreview(); });
  $("pvBlock").addEventListener("change", (e) => { previewBlock = e.target.value; renderPreview(); });
  $("pvName").addEventListener("change", (e) => { previewNumber = e.target.value; renderPreview(); });
  $("pvCode").addEventListener("change", (e) => { previewCode = e.target.value; renderPreview(); });
  $("pvSearch").addEventListener("input", renderPreview);
  $("pvSort").addEventListener("click", () => { oldestFirst.preview = !oldestFirst.preview; renderPreview(); });

  // ----- settings page -----
  $("exportBtn").addEventListener("click", exportBackup);
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ""; });
  $("sampleBtn").addEventListener("click", () => {
    askConfirm("Restore sample data", "This replaces everything with the original sample classes and sheets. You can undo this right after.", "Restore", () => {
      applyChange("Sample data restored.", () => { store.replaceAll(JSON.parse(JSON.stringify(SAMPLE_DATA))); selectedCourseId = null; }, true);
    });
  });
  $("clearBtn").addEventListener("click", () => {
    askConfirm("Clear all data", "This deletes every course, student and attendance sheet in this browser. You can undo this right after.", "Clear everything", () => {
      applyChange("All data cleared.", () => { store.replaceAll({ courses: [], students: [], enrollments: [], sheets: [] }); selectedCourseId = null; }, true);
    });
  });
  if (AUTH) {
    $("accountCard").hidden = false;
    $("accountInfo").textContent = "Signed in as " + AUTH.currentUser().name + " (" + AUTH.currentUser().email + ").";
    $("logoutBtn").addEventListener("click", () => AUTH.logout().catch((err) => showToast("Could not log out: " + err.message, true)));
  }
}


// splits one CSV line, keeping commas that are inside "quotes"
function splitCsvLine(line) {
  const parts = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || [];
  return parts.filter((p, i) => i < parts.length - 1 || p !== "")
    .map((p) => p.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
}

// ---- reading .xlsx files with no library: an .xlsx is a zip of XML files ----
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function openZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;   // find the zip's table of contents
  if (end < 0) throw new Error("not a zip");
  const files = {};
  let pos = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const nameLength = view.getUint16(pos + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    files[name] = { method: view.getUint16(pos + 10, true), size: view.getUint32(pos + 20, true), offset: view.getUint32(pos + 42, true) };
    pos += 46 + nameLength + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
  }
  async function read(name) {
    const file = files[name];
    if (!file) return null;
    const start = file.offset + 30 + view.getUint16(file.offset + 26, true) + view.getUint16(file.offset + 28, true);
    const raw = bytes.subarray(start, start + file.size);
    return new TextDecoder().decode(file.method === 0 ? raw : await inflate(raw));
  }
  return { names: Object.keys(files), read };
}

async function readXlsxRows(buffer) {
  const zip = openZip(buffer);
  const parse = (text) => new DOMParser().parseFromString(text, "application/xml");
  const sharedText = [];
  const shared = await zip.read("xl/sharedStrings.xml");
  if (shared) parse(shared).querySelectorAll("si").forEach((si) => sharedText.push([...si.querySelectorAll("t")].map((t) => t.textContent).join("")));

  const sheetName = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  const rows = [];
  parse(await zip.read(sheetName)).querySelectorAll("row").forEach((row) => {
    const cells = [];
    row.querySelectorAll("c").forEach((cell) => {
      let column = 0;
      for (const letter of cell.getAttribute("r").replace(/\d+/g, "")) column = column * 26 + letter.charCodeAt(0) - 64;
      const value = cell.querySelector("v");
      const type = cell.getAttribute("t");
      if (type === "s") cells[column - 1] = sharedText[Number(value.textContent)];
      else if (type === "inlineStr") cells[column - 1] = cell.textContent;
      else cells[column - 1] = value ? value.textContent : "";
    });
    rows.push(cells);
  });
  return rows;
}

// reads the file and gives back the rows (a list of lists)
function readRows(file, done) {
  const reader = new FileReader();
  reader.onerror = () => showToast("Could not read that file.", true);

  if (file.name.toLowerCase().endsWith(".csv")) {
    reader.onload = () => done(reader.result.replace(/^\uFEFF/, "").split(/\r?\n/).map(splitCsvLine));
    reader.readAsText(file);
  } else {
    reader.onload = async () => {
      try {
        done(await readXlsxRows(reader.result));
      } catch (err) {
        showToast("Could not read that Excel file. Use a .xlsx or .csv file.", true);
      }
    };
    reader.readAsArrayBuffer(file);
  }
}


// ===================== custom dropdowns and calendar (pop-ups that match the theme) =====================

let openPopup = null;   // the dropdown menu or calendar that is open right now

function closePopup() {
  if (!openPopup) return;
  openPopup.box.remove();
  openPopup.anchor.setAttribute("aria-expanded", "false");
  openPopup = null;
}

// puts a pop-up under its button (or above it if there is no room)
function placePopup(box, anchor, minWidth) {
  const r = anchor.getBoundingClientRect();
  if (minWidth) box.style.minWidth = Math.max(r.width, minWidth) + "px";
  let top = r.bottom + 6;
  if (top + box.offsetHeight > innerHeight - 8 && r.top - box.offsetHeight - 6 > 8) top = r.top - box.offsetHeight - 6;
  box.style.top = Math.max(8, top) + "px";
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8)) + "px";
}

function showPopup(box, anchor, minWidth) {
  closePopup();
  document.body.appendChild(box);
  placePopup(box, anchor, minWidth);
  anchor.setAttribute("aria-expanded", "true");
  openPopup = { box, anchor };
}

document.addEventListener("mousedown", (e) => {
  if (openPopup && !openPopup.box.contains(e.target) && !openPopup.anchor.contains(e.target)) closePopup();
});
window.addEventListener("resize", closePopup);
window.addEventListener("scroll", (e) => { if (openPopup && !openPopup.box.contains(e.target)) closePopup(); }, true);

// ----- dropdown: the real <select> stays hidden inside, so the rest of the code works as before -----
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

function buildDropdown(select) {
  const wrap = document.createElement("div");
  wrap.className = "dd";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dd-btn";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = '<span class="dd-text"></span>' + CHEVRON;
  select.before(wrap);
  wrap.append(button, select);
  select.classList.add("dd-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  button.addEventListener("click", () => openMenu(select, button));
  button.addEventListener("keydown", (e) => {
    if (["ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); openMenu(select, button); }
  });
}

function syncDropdown(select) {
  const button = select.parentElement.querySelector(".dd-btn");
  const chosen = select.options[select.selectedIndex];
  const text = chosen ? chosen.textContent : "None yet";
  const label = select.getAttribute("aria-label") || (select.closest("label") ? select.closest("label").querySelector(".label").textContent : "");
  const textBox = button.querySelector(".dd-text");
  if (textBox.textContent !== text) textBox.textContent = text;
  if (button.getAttribute("aria-label") !== label + ": " + text) button.setAttribute("aria-label", label + ": " + text);
  button.disabled = select.options.length === 0;
}

function openMenu(select, button) {
  if (openPopup && openPopup.anchor === button) return closePopup();
  const menu = document.createElement("div");
  menu.className = "dd-menu";
  menu.tabIndex = -1;
  menu.setAttribute("role", "listbox");
  let html = "";
  [...select.children].forEach((child) => {
    const options = child.tagName === "OPTGROUP" ? [...child.children] : [child];
    if (child.tagName === "OPTGROUP") html += `<div class="dd-group">${escapeHtml(child.label)}</div>`;
    options.forEach((o) => {
      html += `<div class="dd-opt" role="option" data-value="${escapeHtml(o.value)}" aria-selected="${o.value === select.value}">${escapeHtml(o.textContent)}</div>`;
    });
  });
  menu.innerHTML = html;
  const items = [...menu.querySelectorAll(".dd-opt")];
  let active = Math.max(0, items.findIndex((i) => i.getAttribute("aria-selected") === "true"));

  function highlight(index) {
    active = (index + items.length) % items.length;
    items.forEach((item, i) => item.classList.toggle("active", i === active));
    items[active].scrollIntoView({ block: "nearest" });
  }
  function choose(item) {
    closePopup();
    button.focus();
    if (select.value !== item.dataset.value) {
      select.value = item.dataset.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  menu.addEventListener("click", (e) => { const item = e.target.closest(".dd-opt"); if (item) choose(item); });
  menu.addEventListener("mousemove", (e) => { const item = e.target.closest(".dd-opt"); if (item) highlight(items.indexOf(item)); });
  menu.addEventListener("keydown", (e) => {
    const keys = { ArrowDown: () => highlight(active + 1), ArrowUp: () => highlight(active - 1), Home: () => highlight(0), End: () => highlight(items.length - 1),
                   Enter: () => choose(items[active]), " ": () => choose(items[active]), Escape: () => { closePopup(); button.focus(); }, Tab: () => closePopup() };
    if (keys[e.key]) { if (e.key !== "Tab") e.preventDefault(); e.stopPropagation(); keys[e.key](); return; }
    const typed = items.findIndex((item, i) => i > active && item.textContent.toLowerCase().startsWith(e.key.toLowerCase()));   // type a letter to jump
    if (e.key.length === 1 && typed >= 0) highlight(typed);
  });

  showPopup(menu, button, 180);
  highlight(active);
  menu.focus();
}

// ----- calendar pop-up -----
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function toIso(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

// options: value (yyyy-mm-dd), marked (dates that have a saved sheet), allowClear, onPick(date)
function openCalendar(anchor, options) {
  if (openPopup && openPopup.anchor === anchor) return closePopup();
  let focusDay = options.value || getToday();
  let month = new Date(focusDay + "T00:00:00");
  month.setDate(1);

  const box = document.createElement("div");
  box.className = "cal";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Choose a date");

  function draw() {
    const first = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());   // start on the Sunday before the 1st
    let days = "";
    for (let i = 0; i < 42; i++) {
      const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
      const iso = toIso(day);
      const classes = ["cal-day", day.getMonth() !== month.getMonth() ? "other" : "", iso === getToday() ? "today" : "", iso === options.value ? "picked" : "", options.marked.has(iso) ? "marked" : ""].join(" ");
      days += `<button type="button" class="${classes}" data-date="${iso}" tabindex="${iso === focusDay ? 0 : -1}" aria-label="${longDate(iso)}">${day.getDate()}</button>`;
    }
    box.innerHTML = `
      <div class="cal-head">
        <button type="button" class="cal-nav" data-move="-1" aria-label="Previous month">&#8249;</button>
        <span class="cal-title" aria-live="polite">${MONTHS[month.getMonth()]} ${month.getFullYear()}</span>
        <button type="button" class="cal-nav" data-move="1" aria-label="Next month">&#8250;</button>
      </div>
      <div class="cal-grid">${WEEKDAYS.map((w) => `<span class="cal-week">${w}</span>`).join("")}${days}</div>
      <div class="cal-foot">
        <button type="button" class="cal-link" data-today>Today</button>
        ${options.allowClear ? '<button type="button" class="cal-link" data-clear>Clear date</button>' : ""}
      </div>
      ${options.marked.size ? '<p class="cal-legend">A dot means a saved attendance sheet.</p>' : ""}`;
  }

  function pick(iso) {
    closePopup();
    anchor.focus();
    options.onPick(iso);
  }

  box.addEventListener("click", (e) => {
    const move = e.target.closest("[data-move]");
    const day = e.target.closest("[data-date]");
    if (move) { month.setMonth(month.getMonth() + Number(move.dataset.move)); draw(); }
    else if (day) pick(day.dataset.date);
    else if (e.target.closest("[data-today]")) pick(getToday());
    else if (e.target.closest("[data-clear]")) pick("");
  });
  box.addEventListener("keydown", (e) => {
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key === "Escape") { e.stopPropagation(); closePopup(); anchor.focus(); }
    if (!(e.key in steps) && !["PageUp", "PageDown"].includes(e.key)) return;
    e.preventDefault();
    const next = new Date(focusDay + "T00:00:00");
    if (e.key in steps) next.setDate(next.getDate() + steps[e.key]);
    else next.setMonth(next.getMonth() + (e.key === "PageUp" ? -1 : 1));
    focusDay = toIso(next);
    month = new Date(next.getFullYear(), next.getMonth(), 1);
    draw();
    box.querySelector(`[data-date="${focusDay}"]`).focus();
  });

  draw();
  showPopup(box, anchor);
  box.querySelector(`[data-date="${focusDay}"]`).focus();
}

// ----- keeps every dropdown, date button and table label up to date -----
function refreshDropdowns() {
  document.querySelectorAll("select").forEach((select) => {
    if (!select.closest(".dd")) buildDropdown(select);
    syncDropdown(select);
  });
  document.querySelectorAll(".date-btn").forEach((button) => {
    const value = $(button.dataset.for).value;
    const text = value ? longDate(value) : button.dataset.empty || "";
    const span = button.querySelector(".date-text");
    if (span.textContent !== text) span.textContent = text;
  });
  document.querySelectorAll("table").forEach((table) => {          // labels used when a table turns into cards on small screens
    const heads = [...table.querySelectorAll("th")].map((th) => th.textContent);
    table.querySelectorAll("tbody tr").forEach((row) => {
      [...row.children].forEach((cell, i) => { if (heads[i] && cell.dataset.label !== heads[i]) cell.dataset.label = heads[i]; });
    });
  });
}

// whenever a page re-draws its tables or dropdowns, tidy up the new ones
new MutationObserver(() => requestAnimationFrame(refreshDropdowns)).observe(document.body, { childList: true, subtree: true });

function setupPopups() {
  // every date button opens the calendar for its hidden date box (data-for)
  document.querySelectorAll(".date-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const input = $(button.dataset.for);
      const course = getCourse();
      const onlyThisClass = button.dataset.for === "attDate";
      const marked = new Set(sheets.filter((s) => !onlyThisClass || (course && s.courseId === course.id)).map((s) => s.date));
      openCalendar(button, { value: input.value, marked, allowClear: Boolean(button.dataset.empty), onPick: (iso) => {
        input.value = iso;
        input.dispatchEvent(new Event("change"));
        refreshDropdowns();
      } });
    });
  });
}

// ===================== dark / light switch =====================

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("attendease-theme", theme);
  const dark = theme === "dark";
  $("themeLabel").textContent = dark ? "Dark mode" : "Light mode";
  $("themeBtn").setAttribute("aria-checked", String(dark));
}

// ===================== start =====================

function showProfile() {
  if (!AUTH) return;
  const user = AUTH.currentUser();
  $("profileName").textContent = user.name;
  $("profileNote").textContent = "Signed in";
  $("avatar").textContent = user.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

async function init() {
  applyTheme(document.documentElement.dataset.theme || "light");
  $("themeBtn").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  setupEvents();
  setupPopups();
  showProfile();
  await loadData();
  renderAll();
  refreshDropdowns();
}

// the login version waits for a successful log in first
if (AUTH) AUTH.show(init);
else init();
