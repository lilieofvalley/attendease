// AttendEase data rules (no screen code here), so they can be tested with:  node tests/tests.js
// Students are stored ONCE. A student joins a class through an "enrollment" ({ courseId, studentId }).
(function (root) {
  "use strict";

  const STATUSES = ["present", "late", "excused", "absent"];
  const ABSENCE_WARNING = 3;                       // flag a student after this many absences
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_PATTERN = /^\d{2}:\d{2}$/;
  const HEADER_PATTERN = /^\s*(student\s*(id|no|number)|id)\s*$/i;

  function cleanText(value) {
    return String(value === undefined || value === null ? "" : value).trim().replace(/\s+/g, " ");
  }

  // ---------- old saved data had a copy of each student in every class; this joins them ----------
  function migrate(data) {
    if (!data || !Array.isArray(data.students) || !Array.isArray(data.courses) || !Array.isArray(data.sheets)) return data;
    const courses = data.courses.map((c) => Object.assign({ days: [], start: "", end: "" }, c));
    if (Array.isArray(data.enrollments)) return Object.assign({}, data, { courses });

    const people = [];
    const enrollments = [];
    const newIdOf = {};                            // old student id -> new student id
    data.students.forEach((old) => {
      let person = people.find((p) => p.studentNumber === old.studentNumber);
      if (!person) {
        person = { id: people.length + 1, studentNumber: old.studentNumber, lastName: old.lastName, firstName: old.firstName };
        people.push(person);
      }
      newIdOf[old.id] = person.id;
      if (!enrollments.some((e) => e.courseId === old.courseId && e.studentId === person.id)) enrollments.push({ courseId: old.courseId, studentId: person.id });
    });
    const sheets = data.sheets.map((sheet) => Object.assign({}, sheet, {
      records: sheet.records.filter((r) => newIdOf[r.studentId]).map((r) => ({ studentId: newIdOf[r.studentId], status: r.status }))
    }));
    return { courses, students: people, enrollments, sheets, counters: {} };
  }

  // checks that a saved or imported file really looks like AttendEase data
  function isValidData(raw) {
    let data;
    try { data = migrate(raw); } catch (err) { return false; }
    const ok = (list, test) => Array.isArray(list) && list.every((item) => item && typeof item === "object" && test(item));
    const text = (t) => typeof t === "string";
    return Boolean(data) &&
      ok(data.courses, (c) => Number.isInteger(c.id) && [c.program, c.name, c.code, c.block].every(text) && Array.isArray(c.days)) &&
      ok(data.students, (s) => Number.isInteger(s.id) && [s.studentNumber, s.lastName, s.firstName].every(text)) &&
      ok(data.enrollments, (e) => Number.isInteger(e.courseId) && Number.isInteger(e.studentId)) &&
      ok(data.sheets, (sh) => Number.isInteger(sh.id) && Number.isInteger(sh.courseId) && DATE_PATTERN.test(sh.date) &&
        ok(sh.records, (r) => Number.isInteger(r.studentId) && STATUSES.includes(r.status)));
  }

  // ---------- numbers ----------
  function countStatuses(list) {
    const counts = { present: 0, late: 0, excused: 0, absent: 0 };
    list.forEach((status) => { if (status in counts) counts[status]++; });
    return counts;
  }

  // present + late count as attending; excused days are left out of the total
  function attendanceRate(counts) {
    const total = counts.present + counts.late + counts.absent;
    return total === 0 ? null : Math.round(((counts.present + counts.late) / total) * 100);
  }

  // ---------- the store: all lists live here and are changed in place ----------
  function createStore() {
    const state = { courses: [], students: [], enrollments: [], sheets: [] };
    let counters = {};                             // next id per kind, so a deleted id is never used again
    const fail = (message) => { throw new Error(message); };

    function removeWhere(list, test) {
      for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) list.splice(i, 1);
    }

    function nextId(list, kind) {
      const highest = list.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
      counters[kind] = Math.max(counters[kind] || 1, highest + 1);
      return counters[kind]++;
    }

    function replaceAll(raw) {
      const data = migrate(raw);
      Object.keys(state).forEach((key) => state[key].splice(0, state[key].length, ...data[key]));
      counters = Object.assign({}, data.counters);
    }

    const toData = () => ({ courses: state.courses, students: state.students, enrollments: state.enrollments, sheets: state.sheets, counters });
    const snapshot = () => JSON.stringify(toData());      // used by Undo
    const restore = (text) => replaceAll(JSON.parse(text));

    // ----- looking things up -----
    const courseById = (id) => state.courses.find((c) => c.id === id);
    const findSheet = (courseId, date) => state.sheets.find((s) => s.courseId === courseId && s.date === date);
    const studentsOf = (courseId) => state.enrollments.filter((e) => e.courseId === courseId)
      .map((e) => state.students.find((s) => s.id === e.studentId)).filter(Boolean);
    const coursesOf = (studentId) => state.enrollments.filter((e) => e.studentId === studentId)
      .map((e) => courseById(e.courseId)).filter(Boolean);

    function statsFor(studentId, courseId) {
      const statuses = [];
      state.sheets.filter((s) => courseId === undefined || s.courseId === courseId).forEach((sheet) => {
        const record = sheet.records.find((r) => r.studentId === studentId);
        if (record) statuses.push(record.status);
      });
      return countStatuses(statuses);
    }

    // ----- courses -----
    function cleanCourse(body) {
      const course = {
        program: cleanText(body.program).toUpperCase(),
        name: cleanText(body.name),
        code: cleanText(body.code).toUpperCase(),
        block: cleanText(body.block).toUpperCase(),
        days: [...new Set((body.days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort(),   // 0 = Sunday
        start: cleanText(body.start),
        end: cleanText(body.end)
      };
      if (!course.program || !course.name || !course.code || !course.block) fail("Please fill in all the course fields.");
      if (Boolean(course.start) !== Boolean(course.end)) fail("Set both a start and an end time, or leave both empty.");
      if (course.start && !(TIME_PATTERN.test(course.start) && TIME_PATTERN.test(course.end))) fail("Use a valid time.");
      if (course.start && course.start >= course.end) fail("The class must end after it starts.");
      return course;
    }

    function checkDuplicateCourse(course, ignoreId) {
      const same = state.courses.some((c) => c.id !== ignoreId && c.program === course.program && c.block === course.block && c.name.toLowerCase() === course.name.toLowerCase());
      if (same) fail("That course and block already exists.");
    }

    function addCourse(body) {
      const course = cleanCourse(body);
      checkDuplicateCourse(course);
      course.id = nextId(state.courses, "course");
      state.courses.push(course);
      return course;
    }

    function updateCourse(id, body) {
      const course = courseById(id) || fail("Course not found.");
      const changes = cleanCourse(body);
      checkDuplicateCourse(changes, id);
      return Object.assign(course, changes);
    }

    function dropStudentsWithoutClass() {
      removeWhere(state.students, (s) => !state.enrollments.some((e) => e.studentId === s.id));
    }

    function deleteCourse(id) {
      if (!courseById(id)) fail("Course not found.");
      removeWhere(state.courses, (c) => c.id === id);
      removeWhere(state.enrollments, (e) => e.courseId === id);
      removeWhere(state.sheets, (s) => s.courseId === id);
      dropStudentsWithoutClass();
    }

    // ----- students -----
    function addStudent(courseId, body) {
      const number = cleanText(body.studentNumber);
      const last = cleanText(body.lastName);
      const first = cleanText(body.firstName);
      if (!number || !last || !first) fail("Please fill in the student ID and the name.");
      if (!courseById(courseId)) fail("Course not found.");

      let student = state.students.find((s) => s.studentNumber === number);     // the same ID is the same student
      if (student && state.enrollments.some((e) => e.courseId === courseId && e.studentId === student.id)) fail("That student ID is already in this class.");
      if (!student) {
        student = { id: nextId(state.students, "student"), studentNumber: number, lastName: last, firstName: first };
        state.students.push(student);
      }
      state.enrollments.push({ courseId, studentId: student.id });
      return student;
    }

    function updateStudent(id, body) {
      const student = state.students.find((s) => s.id === id) || fail("Student not found.");
      const changes = { studentNumber: cleanText(body.studentNumber), lastName: cleanText(body.lastName), firstName: cleanText(body.firstName) };
      if (!changes.studentNumber || !changes.lastName || !changes.firstName) fail("Please fill in the student ID and the name.");
      if (state.students.some((s) => s.id !== id && s.studentNumber === changes.studentNumber)) fail("Another student already has that ID.");
      return Object.assign(student, changes);
    }

    // takes the student out of ONE class; the student stays in their other classes
    function removeStudent(courseId, studentId) {
      removeWhere(state.enrollments, (e) => e.courseId === courseId && e.studentId === studentId);
      state.sheets.filter((s) => s.courseId === courseId).forEach((sheet) => {
        sheet.records = sheet.records.filter((r) => r.studentId !== studentId);
      });
      removeWhere(state.sheets, (s) => s.records.length === 0);
      dropStudentsWithoutClass();
    }

    function importStudents(courseId, rows) {
      const lines = rows.slice();
      if (lines.length && HEADER_PATTERN.test(String(lines[0][0] || ""))) lines.shift();   // skip a header row
      let added = 0;
      let skipped = 0;
      lines.forEach((row) => {
        const [number, last, first] = [0, 1, 2].map((i) => cleanText(row[i]));
        if (!number && !last && !first) return;
        try { addStudent(courseId, { studentNumber: number, lastName: last, firstName: first }); added++; } catch (err) { skipped++; }
      });
      return { added, skipped };
    }

    // ----- attendance sheets -----
    function saveSheet(courseId, date, records) {
      if (!courseById(courseId)) fail("Course not found.");
      if (!DATE_PATTERN.test(date)) fail("Please pick a valid date.");
      if (!records.length || records.some((r) => !STATUSES.includes(r.status))) fail("The attendance marks are missing or not valid.");
      let sheet = findSheet(courseId, date);
      const updated = Boolean(sheet);
      const clean = records.map((r) => ({ studentId: Number(r.studentId), status: r.status }));
      if (sheet) sheet.records = clean;
      else { sheet = { id: nextId(state.sheets, "sheet"), courseId, date, records: clean }; state.sheets.push(sheet); }
      return { sheet, updated };
    }

    function deleteSheet(id) {
      removeWhere(state.sheets, (s) => s.id === id);
    }

    // records of one student between two dates that would change to "status" (courseIds is optional)
    function findInRange({ studentId, from, to, status, courseIds }) {
      const found = [];
      state.sheets.forEach((sheet) => {
        if (!(sheet.date >= from && sheet.date <= to)) return;
        if (courseIds && !courseIds.includes(sheet.courseId)) return;
        sheet.records.forEach((r) => { if (r.studentId === studentId && r.status !== status) found.push(r); });
      });
      return found;
    }

    function setStatusInRange(options) {
      if (!STATUSES.includes(options.status)) fail("Pick a status.");
      if (!DATE_PATTERN.test(options.from) || !DATE_PATTERN.test(options.to)) fail("Pick both dates.");
      if (options.from > options.to) fail("The start date must not be after the end date.");
      const found = findInRange(options);
      if (!found.length) fail("No records to change in that range.");
      found.forEach((r) => { r.status = options.status; });
      return found.length;
    }

    return { state, replaceAll, toData, snapshot, restore, courseById, findSheet, studentsOf, coursesOf, statsFor,
             addCourse, updateCourse, deleteCourse, addStudent, updateStudent, removeStudent, importStudents,
             saveSheet, deleteSheet, findInRange, setStatusInRange };
  }

  // ---------- .xlsx writer with no library (an .xlsx is a zip of XML files, stored uncompressed) ----------
  function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
  }

  function makeZip(files) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    Object.keys(files).forEach((name) => {
      const nameBytes = encoder.encode(name);
      const data = encoder.encode(files[name]);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(12, 33, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(14, 33, true);
      entry.setUint32(16, crc, true); entry.setUint32(20, data.length, true); entry.setUint32(24, data.length, true);
      entry.setUint16(28, nameBytes.length, true); entry.setUint32(42, offset, true);
      parts.push(new Uint8Array(local.buffer), nameBytes, data);
      central.push(new Uint8Array(entry.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    });
    const end = new DataView(new ArrayBuffer(22));
    const centralSize = central.reduce((total, p) => total + p.length, 0);
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const result = new Uint8Array(all.reduce((total, p) => total + p.length, 0));
    let position = 0;
    all.forEach((p) => { result.set(p, position); position += p.length; });
    return result;
  }

  // rows is a list of lists of text; returns the bytes of an .xlsx file with one sheet
  function buildXlsx(rows, sheetName) {
    const xml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const rels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const sheetXml = head + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="12" width="18" customWidth="1"/></cols><sheetData>' +
      rows.map((row, r) => `<row r="${r + 1}">` + row.map((value, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`).join("") + "</row>").join("") +
      "</sheetData></worksheet>";
    return makeZip({
      "[Content_Types].xml": head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      "_rels/.rels": head + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rels}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": head + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rels}"><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": head + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rels}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": sheetXml
    });
  }

  const api = { STATUSES, ABSENCE_WARNING, cleanText, migrate, isValidData, countStatuses, attendanceRate, createStore, buildXlsx };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AttendEaseData = api;
})(typeof window !== "undefined" ? window : globalThis);