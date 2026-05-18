// =============================================================================
// Overtime Calculator — calculation rules
// =============================================================================
// Working hours: 08:00 → 16:30 (configurable)
// - Regular weekday OT: time past 16:30 only, must be ≥ 1 hour
// - Saturday: like weekday for OT, +1 day credit (Clarification)
// - Friday: full holiday — all worked hours are OT (minus break), +2 day credit
// - Public holiday: same as Friday (+2 day credit by default; editable per holiday)
// - Sahar (16:30 → 24:00 same day): 7:30 in separate Night Hours column; not in Approved
// - Continuation morning (00:00 → next morning ≤ 08:00): attendance only, no OT
// Times in this code are expressed in HOURS (e.g., 16.5 = 16:30).
// =============================================================================

let state = {
  workbook: null,
  rawRows: [],           // parsed rows from sheet (header preserved)
  headerRows: [],        // rows 1..6
  dataStartRow: 7,
  employees: [],         // computed
  settings: {
    shiftStart: 8.0,
    shiftEnd: 16.5,
    sahar: { start: 16.5, end: 24.0, total: 7.5 },
    breakMinutes: 30,
    minOtHours: 1.0,
    fridayDays: 2,
    saturdayDays: 1,
  },
  holidays: {},          // { 'YYYY-MM-DD': {name, days} }
};

// ---------- helpers ----------
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtDateShort(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}
function hoursToHHMM(h) {
  if (h == null || isNaN(h) || h === 0) return '';
  const sign = h < 0 ? '-' : '';
  h = Math.abs(h);
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  if (mm === 60) return `${sign}${pad(hh + 1)}:00`;
  return `${sign}${pad(hh)}:${pad(mm)}`;
}
function hoursToExcelTime(h) {
  // Excel time = fraction of day
  if (h == null || isNaN(h) || h === 0) return null;
  return h / 24;
}

// Parse an Excel cell representing a time/duration (HH:MM) into hours (decimal).
// Prefer the formatted display string `w` (e.g. "16:30", "24:00", "2:30") — it's the
// most reliable representation and avoids timezone issues with Date objects.
function cellToHours(cell) {
  if (cell == null) return null;
  if (typeof cell === 'object') {
    if (cell.w) {
      const m = String(cell.w).trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
      if (m) return +m[1] + (+m[2]) / 60 + (m[3] ? +m[3] / 3600 : 0);
    }
    if (typeof cell.v === 'number') return cell.v * 24;
    if (cell.v instanceof Date) {
      const ep = Date.UTC(1899, 11, 30);
      const ms = cell.v.getTime() - ep;
      const fracDay = ms / 86400000;
      return fracDay * 24;
    }
  }
  if (typeof cell === 'number') return cell * 24;
  if (typeof cell === 'string') {
    const m = cell.trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (m) return +m[1] + (+m[2]) / 60 + (m[3] ? +m[3] / 3600 : 0);
  }
  return null;
}

const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function cellToDate(cell) {
  if (!cell) return null;
  // Prefer the formatted display string (e.g. "1-Apr-26") — avoids timezone shifts
  // that occur when SheetJS converts Excel dates to JS Date with cellDates:true.
  if (typeof cell === 'object' && cell.w) {
    const w = String(cell.w).trim();
    let m = w.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
    if (m) {
      const mo = MONTHS[m[2].toLowerCase()];
      let y = +m[3]; if (y < 100) y += 2000;
      if (mo != null) return new Date(y, mo, +m[1], 12, 0, 0);
    }
    m = w.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      return new Date(y, +m[2] - 1, +m[1], 12, 0, 0);
    }
    m = w.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  }
  const v = (typeof cell === 'object' && 'v' in cell) ? cell.v : cell;
  if (v instanceof Date) {
    // Shift forward 12h to avoid local-midnight day rollover from TZ conversion.
    return new Date(v.getTime() + 12 * 3600 * 1000);
  }
  if (typeof v === 'number') {
    // Excel serial date: build local noon to dodge TZ rollover.
    const utc = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), 12, 0, 0);
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function dayName(d) {
  if (!d) return '';
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
}

// ---------- core calculation ----------
function calculateRow(parsed) {
  // parsed: { day, date, id, name, from, to, hours }
  // Returns: { approved, night, clarification, kind }
  const out = { approved: 0, night: 0, clarification: 0, kind: 'regular' };
  if (parsed.from == null && parsed.to == null) return out;
  if (parsed.from == null || parsed.to == null) return out;

  const from = parsed.from;
  const to = parsed.to;
  const work = to - from;
  if (work <= 0) return out;

  const s = state.settings;
  const dateStr = fmtDate(parsed.date);
  const day = parsed.day || dayName(parsed.date);
  const isFriday = day === 'Friday';
  const isSaturday = day === 'Saturday';
  const holiday = state.holidays[dateStr];
  const breakHours = s.breakMinutes / 60;

  // Friday: full holiday — every worked hour counts as OT (minus break)
  if (isFriday) {
    out.kind = 'friday';
    out.clarification = s.fridayDays;
    const ot = work - breakHours;
    if (ot >= s.minOtHours) out.approved = ot;
    return out;
  }

  // Public holiday (e.g., Sham El-Nessim): day credit only, OT past 16:30 like a regular weekday
  if (holiday) {
    out.kind = 'holiday';
    out.clarification = holiday.days;
    const ot = Math.max(0, to - s.shiftEnd);
    if (ot >= s.minOtHours) out.approved = ot;
    return out;
  }

  // Sahar shift: 16:30 → 24:00 exactly (any shift ending at 24:00 with start ≤ 16:30)
  const endsAtMidnight = Math.abs(to - s.sahar.end) < 0.01;
  if (endsAtMidnight && from >= s.sahar.start - 0.01) {
    // Pure sahar shift
    out.kind = 'sahar';
    out.night = s.sahar.total;
    if (isSaturday) out.clarification = s.saturdayDays;
    return out;
  }
  if (endsAtMidnight && from < s.sahar.start) {
    // Full shift + sahar (e.g., 8:00 → 24:00). Regular shift portion not OT, sahar = 7:30.
    out.kind = 'sahar';
    out.night = s.sahar.total;
    if (isSaturday) out.clarification = s.saturdayDays;
    return out;
  }

  // Continuation morning: from = 0:00 and to ≤ 16:30 (worker came from previous night)
  if (from < 0.01 && to <= s.shiftEnd + 0.01) {
    out.kind = 'continuation';
    // Attendance only — no OT, no day credit (continuation of prior shift)
    if (isSaturday) out.clarification = s.saturdayDays;
    return out;
  }

  if (isSaturday) {
    out.kind = 'saturday';
    out.clarification = s.saturdayDays;
    const ot = Math.max(0, to - s.shiftEnd);
    if (ot >= s.minOtHours) out.approved = ot;
    return out;
  }

  // Regular weekday OT
  const ot = Math.max(0, to - s.shiftEnd);
  if (ot >= s.minOtHours) out.approved = ot;
  return out;
}

// ---------- file parsing ----------
function parseSheet(ws) {
  const ref = ws['!ref'];
  if (!ref) throw new Error('الشيت فاضي');
  const range = XLSX.utils.decode_range(ref);
  const rows = [];
  // Always iterate from row 0 (A1) — some sheets have `!ref` starting at non-zero rows.
  for (let R = 0; R <= range.e.r; R++) {
    const row = [];
    for (let C = 0; C < 9; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = ws[addr];
      // Keep the cell object so downstream parsers can use .w for formatted values
      row.push(cell || null);
    }
    rows.push(row);
  }
  return rows;
}

function processWorkbook(wb) {
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = parseSheet(ws);

  const cv = (c) => (c && typeof c === 'object' && 'v' in c) ? c.v : c;

  // header rows = 0..5 (rows 1..6 in spreadsheet)
  state.headerRows = rows.slice(0, 6).map(r => r.map(cv));
  state.rawRows = rows;
  state.workbook = wb;
  state.sheetName = sheetName;

  // Group by employee. Each employee block ends at a row with col A = 'Total:'
  const employees = [];
  let cur = null;
  for (let i = 6; i < rows.length; i++) {
    const r = rows[i];
    const dayVal = cv(r[0]);
    const idVal = cv(r[2]);
    const nameVal = cv(r[3]);
    if (dayVal == null && idVal == null && nameVal == null) continue;
    if (typeof dayVal === 'string' && /total/i.test(dayVal)) {
      if (cur) {
        cur.totalRowIndex = i;
        employees.push(cur);
        cur = null;
      }
      continue;
    }
    if (idVal == null || nameVal == null) continue;
    if (!cur || cur.id !== idVal) {
      if (cur) employees.push(cur);
      cur = { id: idVal, name: String(nameVal).trim(), days: [], firstRowIndex: i };
    }
    cur.days.push({
      rowIndex: i,
      day: dayVal,
      date: cellToDate(r[1]),
      id: idVal,
      name: String(nameVal).trim(),
      from: cellToHours(r[4]),
      to: cellToHours(r[5]),
      hours: cellToHours(r[6]),
    });
  }
  if (cur) employees.push(cur);

  // Compute calculations
  for (const e of employees) {
    let totApproved = 0, totNight = 0, totClarif = 0;
    for (const d of e.days) {
      const calc = calculateRow(d);
      d.calc = calc;
      totApproved += calc.approved;
      totNight += calc.night;
      totClarif += calc.clarification;
    }
    e.totals = { approved: totApproved, night: totNight, clarification: totClarif };
  }

  state.employees = employees;
}

// ---------- holidays UI ----------
function loadHolidays(list) {
  state.holidays = {};
  for (const h of list) {
    state.holidays[h.date] = { name: h.name, days: h.days };
  }
}
function renderHolidays() {
  const wrap = document.getElementById('holidays-list');
  wrap.innerHTML = '';
  const sorted = Object.keys(state.holidays).sort();
  const countEl = document.getElementById('holiday-count');
  if (countEl) countEl.textContent = sorted.length.toLocaleString('ar-EG');
  for (const date of sorted) {
    const h = state.holidays[date];
    const row = document.createElement('div');
    row.className = 'holiday-row';
    row.innerHTML = `
      <input type="date" value="${date}" data-orig="${date}">
      <input type="text" value="${h.name.replace(/"/g, '&quot;')}" placeholder="الاسم">
      <select>
        <option value="1" ${h.days === 1 ? 'selected' : ''}>١ يوم</option>
        <option value="2" ${h.days === 2 ? 'selected' : ''}>٢ يوم</option>
        <option value="3" ${h.days === 3 ? 'selected' : ''}>٣ أيام</option>
      </select>
      <button class="btn btn-danger btn-sm del">حذف</button>
    `;
    const [dateIn, nameIn, daysIn, delBtn] = row.querySelectorAll('input, select, button');
    dateIn.addEventListener('change', () => {
      const oldDate = dateIn.dataset.orig;
      const newDate = dateIn.value;
      if (!newDate) return;
      if (newDate !== oldDate) {
        delete state.holidays[oldDate];
        state.holidays[newDate] = { name: nameIn.value, days: +daysIn.value };
        dateIn.dataset.orig = newDate;
        recalcAndRender();
      }
    });
    nameIn.addEventListener('change', () => {
      state.holidays[dateIn.value].name = nameIn.value;
    });
    daysIn.addEventListener('change', () => {
      state.holidays[dateIn.value].days = +daysIn.value;
      recalcAndRender();
    });
    delBtn.addEventListener('click', () => {
      delete state.holidays[dateIn.dataset.orig];
      renderHolidays();
      recalcAndRender();
    });
    wrap.appendChild(row);
  }
}

function recalcAndRender() {
  if (!state.employees.length) return;
  for (const e of state.employees) {
    let totApproved = 0, totNight = 0, totClarif = 0;
    for (const d of e.days) {
      d.calc = calculateRow(d);
      totApproved += d.calc.approved;
      totNight += d.calc.night;
      totClarif += d.calc.clarification;
    }
    e.totals = { approved: totApproved, night: totNight, clarification: totClarif };
  }
  renderPreview();
}

// ---------- preview ----------
function renderEmployeeFilter() {
  const sel = document.getElementById('emp-filter');
  sel.innerHTML = '<option value="">— كل الموظفين —</option>';
  for (const e of state.employees) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = `${e.id} — ${e.name}`;
    sel.appendChild(opt);
  }
}

function renderSummary() {
  const totalEmp = state.employees.length;
  let totalApproved = 0, totalNight = 0, totalClarif = 0;
  for (const e of state.employees) {
    totalApproved += e.totals.approved;
    totalNight += e.totals.night;
    totalClarif += e.totals.clarification;
  }
  const grid = document.getElementById('summary-grid');
  grid.innerHTML = `
    <div class="summary-card"><div class="num">${totalEmp}</div><div class="lbl">عدد الموظفين</div></div>
    <div class="summary-card green"><div class="num">${hoursToHHMM(totalApproved) || '0:00'}</div><div class="lbl">إجمالي ساعات الأوفر تايم</div></div>
    <div class="summary-card purple"><div class="num">${hoursToHHMM(totalNight) || '0:00'}</div><div class="lbl">إجمالي ساعات السهر</div></div>
    <div class="summary-card cyan"><div class="num">${totalClarif}</div><div class="lbl">إجمالي أيام (جمعات/سبتات/أعياد)</div></div>
  `;
}

function renderPreview() {
  renderSummary();
  const filterId = document.getElementById('emp-filter').value;
  const tbody = document.querySelector('#preview-table tbody');
  tbody.innerHTML = '';
  const list = filterId ? state.employees.filter(e => String(e.id) === String(filterId)) : state.employees;

  for (const e of list) {
    for (const d of e.days) {
      const tr = document.createElement('tr');
      const calc = d.calc;
      let tag = '';
      let rowClass = '';
      if (calc.kind === 'holiday') { tag = '<span class="tag tag-hol">عيد رسمي</span>'; rowClass = 'holiday'; }
      else if (calc.kind === 'friday') { tag = '<span class="tag tag-fri">جمعة</span>'; rowClass = 'friday'; }
      else if (calc.kind === 'saturday') { tag = '<span class="tag tag-sat">سبت</span>'; rowClass = 'saturday'; }
      else if (calc.kind === 'sahar') { tag = '<span class="tag tag-sahar">سهر</span>'; rowClass = 'sahar'; }
      else if (calc.kind === 'continuation') { tag = '<span class="tag tag-sahar">امتداد</span>'; }
      tr.className = rowClass;
      tr.innerHTML = `
        <td>${d.day || ''}</td>
        <td>${fmtDateShort(d.date)}</td>
        <td>${d.id}</td>
        <td>${d.name}</td>
        <td class="cell-num">${hoursToHHMM(d.from)}</td>
        <td class="cell-num">${hoursToHHMM(d.to)}</td>
        <td class="cell-num">${hoursToHHMM(d.hours)}</td>
        <td class="cell-num"><strong>${hoursToHHMM(calc.approved)}</strong></td>
        <td class="cell-num">${calc.clarification || ''}</td>
        <td class="cell-num"><strong>${hoursToHHMM(calc.night)}</strong></td>
        <td>${tag}</td>
      `;
      tbody.appendChild(tr);
    }
    // Total row
    const tr = document.createElement('tr');
    tr.className = 'total-row';
    let totalRaw = 0;
    for (const d of e.days) totalRaw += d.hours || 0;
    tr.innerHTML = `
      <td>Total:</td>
      <td></td>
      <td>${e.id}</td>
      <td>${e.name}</td>
      <td></td>
      <td></td>
      <td class="cell-num">${hoursToHHMM(totalRaw)}</td>
      <td class="cell-num"><strong>${hoursToHHMM(e.totals.approved)}</strong></td>
      <td class="cell-num">${e.totals.clarification || ''}</td>
      <td class="cell-num"><strong>${hoursToHHMM(e.totals.night)}</strong></td>
      <td></td>
    `;
    tbody.appendChild(tr);
  }
  document.getElementById('preview-section').classList.remove('hidden');
}

// ---------- export ----------
function exportXlsx() {
  if (!state.workbook) return;
  const wb = XLSX.utils.book_new();
  const data = [];
  // Header rows: rows 1..5 (empty/title) preserved, row 6 = column headers extended
  for (let i = 0; i < 5; i++) {
    data.push(state.headerRows[i].concat([null]));
  }
  data.push(['Day ', 'Date', 'ID', 'Name', 'From', 'To', 'Hours', 'Approved Days', 'Clarification', 'Night Hours']);

  for (const e of state.employees) {
    for (const d of e.days) {
      data.push([
        d.day,
        d.date,
        d.id,
        d.name,
        hoursToExcelTime(d.from),
        hoursToExcelTime(d.to),
        hoursToExcelTime(d.hours),
        d.calc.approved ? hoursToExcelTime(d.calc.approved) : null,
        d.calc.clarification || null,
        d.calc.night ? hoursToExcelTime(d.calc.night) : null,
      ]);
    }
    let totalRaw = 0;
    for (const d of e.days) totalRaw += d.hours || 0;
    data.push([
      'Total:', null, e.id, e.name, null, null,
      hoursToExcelTime(totalRaw),
      e.totals.approved ? hoursToExcelTime(e.totals.approved) : null,
      e.totals.clarification || null,
      e.totals.night ? hoursToExcelTime(e.totals.night) : null,
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);

  // Column widths
  ws['!cols'] = [
    { wch: 11 }, { wch: 11 }, { wch: 7 }, { wch: 32 },
    { wch: 9 }, { wch: 9 }, { wch: 9 },
    { wch: 13 }, { wch: 12 }, { wch: 12 },
  ];

  // Format time cells. SheetJS community doesn't write all styles; we set z (number format) which is preserved.
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = 6; R <= range.e.r; R++) {
    for (const C of [1]) { // date column
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (ws[addr] && ws[addr].v instanceof Date) { ws[addr].t = 'd'; ws[addr].z = 'dd/mm/yyyy'; }
    }
    for (const C of [4, 5, 6, 7, 9]) { // time columns
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (ws[addr] && typeof ws[addr].v === 'number') { ws[addr].t = 'n'; ws[addr].z = '[h]:mm'; }
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, 'QC');
  const filename = (state.fileName || 'overtime').replace(/\.xlsx$/i, '') + '-calculated.xlsx';
  XLSX.writeFile(wb, filename);
}

// ---------- wire up UI ----------
function setStatus(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg || '';
  el.className = 'status ' + (cls || '');
}

function handleFile(file) {
  setStatus('بقرأ الفايل…', '');
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array', cellDates: true });
      state.fileName = file.name;
      processWorkbook(wb);
      renderEmployeeFilter();
      renderPreview();
      document.getElementById('btn-export').disabled = false;
      setStatus(`تم — ${state.employees.length} موظف، ${state.employees.reduce((a,e)=>a+e.days.length,0)} يوم`, 'ok');
    } catch (err) {
      console.error(err);
      setStatus('خطأ: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

window.addEventListener('DOMContentLoaded', () => {
  loadHolidays(window.EGYPT_HOLIDAYS || []);
  renderHolidays();

  const dz = document.getElementById('dropzone');
  const fi = document.getElementById('file-input');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fi.addEventListener('change', () => { if (fi.files[0]) handleFile(fi.files[0]); });

  document.getElementById('btn-export').addEventListener('click', exportXlsx);
  document.getElementById('emp-filter').addEventListener('change', renderPreview);

  // Settings inputs
  const wire = (id, key, parser = (v) => +v) => {
    const el = document.getElementById(id);
    el.addEventListener('change', () => {
      if (key === 'shiftStart' || key === 'shiftEnd') {
        const parts = el.value.split(':');
        state.settings[key] = +parts[0] + (parts[1] ? +parts[1] / 60 : 0);
      } else {
        state.settings[key] = parser(el.value);
      }
      recalcAndRender();
    });
  };
  wire('s-shift-start', 'shiftStart');
  wire('s-shift-end', 'shiftEnd');
  wire('s-break', 'breakMinutes');
  wire('s-min-ot', 'minOtHours');
  wire('s-fri-days', 'fridayDays');
  wire('s-sat-days', 'saturdayDays');

  // Add holiday
  document.getElementById('btn-add-holiday').addEventListener('click', () => {
    const d = document.getElementById('new-hol-date').value;
    const n = document.getElementById('new-hol-name').value.trim();
    const dy = +document.getElementById('new-hol-days').value;
    if (!d || !n) { alert('املأ التاريخ والاسم'); return; }
    state.holidays[d] = { name: n, days: dy };
    document.getElementById('new-hol-date').value = '';
    document.getElementById('new-hol-name').value = '';
    renderHolidays();
    recalcAndRender();
  });
});
