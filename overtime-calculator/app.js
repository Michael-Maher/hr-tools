// =============================================================================
// Overtime Calculator — calculation rules (derived from confirmed file patterns)
// =============================================================================
// Working hours: 08:00 → 16:30 (configurable). All times stored as decimal hours
// (e.g. 16.5 = 16:30). Each row represents one (employee, day).
//
// Rule precedence (first match wins):
//
// 1. Sahar shift: 16:30 → 24:00 (To = 24:00 with From >= 16:30 OR full day reaching 24:00)
//    → Night Hours = 7:30. Approved = 0.
//
// 2. Continuation morning: From = 0:00 (employee worked through midnight from prev day)
//    - If To ≤ 16:30 (left at/before shift end):
//        Approved = min(To - 0:30 break, 15:30 cap)
//    - If To > 16:30 (stayed past shift end into OT):
//        Approved = 15:30 base + (To - 16:30) - 0:30 break = To - 1:30
//
// 3. Regular OT (any day, including Friday/Saturday/Holiday):
//    Approved = max(0, To - 16:30) if ≥ 1 hour, else 0
//
// Day credits (Clarification column) added on top:
//   - Friday   → +2 days only if (worked × 1.5) ≥ 8 (i.e. worked ≥ ~5:20)
//   - Saturday → +1 day  only if (worked × 1.5) ≥ 8
//     Below that threshold, only raw OT hours count (no day credit).
//   - Public holiday → +N days (per holiday config) when worked ≥ 3:30
// =============================================================================

let state = {
  workbook: null,
  originalBytes: null,   // ArrayBuffer of uploaded file — used to re-export with original styles
  rawRows: [],
  headerRows: [],
  dataStartRow: 7,
  employees: [],
  settings: {
    shiftStart: 8.0,
    shiftEnd: 16.5,
    sahar: { start: 16.5, end: 24.0, total: 7.5 },
    breakMinutes: 30,
    minOtHours: 1.0,
    fridayDays: 2,
    saturdayDays: 1,
    continuationCap: 15.5,  // max Approved for the 0-to-16:30 portion of a continuation shift
  },
  holidays: {},
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
  const s = state.settings;
  const dateStr = fmtDate(parsed.date);
  const day = parsed.day || dayName(parsed.date);
  const isFriday = day === 'Friday';
  const isSaturday = day === 'Saturday';
  const holiday = state.holidays[dateStr];
  const breakHours = s.breakMinutes / 60;

  if (parsed.from == null || parsed.to == null) return out;
  const from = parsed.from;
  const to = parsed.to;
  const work = to - from;
  if (work <= 0) return out;

  const isContinuation = from < 0.01;
  const endsAtMidnight = Math.abs(to - s.sahar.end) < 0.01;

  // Day credits — applied across all branches when there's substantial work on that day.
  // - Fri/Sat: require worked-hours × 1.5 ≥ 8 (i.e. OT after the 1.5× multiplier reaches
  //   a full shift). Below that threshold, only the raw OT hours count, no day credit.
  // - Holidays: require minimum-day-credit-hours (default 3:30), or continuation morning.
  const minDayCreditHours = 3.5;
  const friSatGate = work * 1.5 >= 8;
  const holidayGate = isContinuation || work >= minDayCreditHours;
  if (isFriday && friSatGate) out.clarification = s.fridayDays;
  else if (isSaturday && friSatGate) out.clarification = s.saturdayDays;
  else if (holiday && holidayGate && !isContinuation) out.clarification = holiday.days;

  // 1. Sahar shift — full evening to midnight. Night Hours = 7:30, no Approved.
  //    Day credit (set above) is preserved if this falls on Fri/Sat/holiday.
  if (endsAtMidnight) {
    out.kind = 'sahar';
    out.night = s.sahar.total;
    return out;
  }

  // 2. Continuation morning — worked through midnight
  if (isContinuation) {
    out.kind = 'continuation';
    let approved;
    if (to <= s.shiftStart + 0.001) {
      // 0:00 → ≤ 8:00 = the "don't count" window — attendance only, no OT.
      approved = 0;
    } else if (to <= s.shiftEnd - 0.5 + 0.001) {
      // Left before the regular shift's lunch break — single 30 min break deducted.
      approved = to - breakHours;
    } else if (to <= s.shiftEnd + 0.001) {
      // Reached the regular shift end (lunch break consumed) — cap at 15:30.
      approved = s.continuationCap;
    } else {
      // Stayed past the regular shift end — deduct both lunch + extra break (1:00 total
      // beyond the base 0:30) → effectively (To − 1:30), but never below the 15:30 cap.
      approved = Math.max(s.continuationCap, to - 3 * breakHours);
    }
    if (approved < s.minOtHours) approved = 0;
    out.approved = approved;
    return out;
  }

  // 3. Regular OT — past 16:30 only (applies to weekdays, Friday, Saturday and holidays)
  if (isFriday) out.kind = 'friday';
  else if (isSaturday) out.kind = 'saturday';
  else if (holiday) out.kind = 'holiday';
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

// ---------- holidays (shared with /holidays.html via localStorage) ----------
const HOLIDAYS_STORAGE_KEY = 'hr-tools.holidays';

function loadHolidaysFromStorage() {
  state.holidays = {};
  let list = null;
  try {
    const raw = localStorage.getItem(HOLIDAYS_STORAGE_KEY);
    if (raw) list = JSON.parse(raw);
  } catch { /* fall through */ }
  if (!list) list = (window.EGYPT_HOLIDAYS || []).map(h => ({ ...h, enabled: true }));
  for (const h of list) {
    if (h.enabled === false) continue;
    state.holidays[h.date] = { name: h.name, days: h.days };
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
// Edit the ORIGINAL workbook in-place using ExcelJS so that all images, fonts,
// colors, merged cells, column widths and number formats are preserved exactly.

// Set a cell's value and number format without leaking the format to sibling
// cells that share the same underlying style object. ExcelJS stores `style` by
// reference, so we must deep-copy it before mutating numFmt.
function setCellWithFormat(cell, value, numFmt) {
  // Build the plain style object first, then assign — this avoids ExcelJS losing the
  // numFmt override when cell.numFmt is set after a style-object assignment.
  const style = cell.style ? JSON.parse(JSON.stringify(cell.style)) : {};
  if (value != null) style.numFmt = numFmt;
  cell.value = value;
  cell.style = style;
}

async function exportXlsx() {
  if (!state.originalBytes || !state.employees.length) return;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(state.originalBytes);
  const ws = wb.worksheets[0];

  // Find header row by scanning for "Approved Days" — usually row 6.
  let headerRowNum = 6;
  for (let r = 1; r <= 20; r++) {
    const v = ws.getCell(r, 8).value;
    if (v && String(v).toLowerCase().includes('approved')) { headerRowNum = r; break; }
  }
  // Set header for new "Night Hours" column in column J (10)
  const nightHeader = ws.getCell(headerRowNum, 10);
  // Copy style from neighbouring header cell so the new header matches
  const refHeader = ws.getCell(headerRowNum, 9);
  nightHeader.value = 'Night Hours';
  if (refHeader.style) nightHeader.style = JSON.parse(JSON.stringify(refHeader.style));

  // Build an index of (id, dateISO) → calculation so we can match by content even if rows shift
  const byKey = new Map();
  for (const e of state.employees) {
    for (const d of e.days) {
      const k = `${e.id}|${fmtDate(d.date)}`;
      byKey.set(k, d.calc);
    }
    byKey.set(`total|${e.id}`, e.totals);
  }

  // Walk all rows starting just after the header row
  let currentEmpId = null;
  for (let r = headerRowNum + 1; r <= ws.rowCount; r++) {
    const dayCell = ws.getCell(r, 1);
    const idCell  = ws.getCell(r, 3);
    const dateCell= ws.getCell(r, 2);
    const dayVal  = dayCell.value;

    // Total row
    if (typeof dayVal === 'string' && /total/i.test(dayVal)) {
      if (currentEmpId == null) continue;
      const tot = byKey.get(`total|${currentEmpId}`);
      if (tot) {
        const hT = ws.getCell(r, 8);
        const iT = ws.getCell(r, 9);
        const jT = ws.getCell(r, 10);
        setCellWithFormat(hT, tot.approved ? tot.approved / 24 : null, '[h]:mm');
        setCellWithFormat(iT, tot.clarification || null, '0');
        setCellWithFormat(jT, tot.night ? tot.night / 24 : null, '[h]:mm');
      }
      currentEmpId = null;
      continue;
    }

    const id = idCell.value;
    if (id == null) continue;
    currentEmpId = id;

    // Extract date for matching
    let dateStr = null;
    const dv = dateCell.value;
    if (dv instanceof Date) {
      // Shift into local-noon to avoid TZ rollover
      const nd = new Date(dv.getTime() + 12 * 3600 * 1000);
      dateStr = `${nd.getUTCFullYear()}-${pad(nd.getUTCMonth() + 1)}-${pad(nd.getUTCDate())}`;
    } else if (typeof dv === 'string') {
      const d2 = cellToDate({ w: dv });
      if (d2) dateStr = fmtDate(d2);
    } else if (typeof dv === 'number') {
      const d2 = cellToDate(dv);
      if (d2) dateStr = fmtDate(d2);
    }
    if (!dateStr) continue;
    const calc = byKey.get(`${id}|${dateStr}`);
    if (!calc) continue;

    // Set Approved (H), Clarification (I), Night Hours (J)
    const hCell = ws.getCell(r, 8);
    const iCell = ws.getCell(r, 9);
    const jCell = ws.getCell(r, 10);

    setCellWithFormat(hCell, calc.approved ? calc.approved / 24 : null, '[h]:mm');
    // Clarification holds a day count (1, 2, 3) — force integer format so the cell
    // can't be misread as a time fraction (Excel renders "1" as "24:00" when a time
    // number-format is inherited from a sibling cell's shared style).
    setCellWithFormat(iCell, calc.clarification || null, '0');
    if (calc.night) {
      setCellWithFormat(jCell, calc.night / 24, '[h]:mm');
    } else {
      jCell.value = null;
    }
  }

  // Ensure column J has a reasonable width
  const colJ = ws.getColumn(10);
  if (!colJ.width || colJ.width < 11) colJ.width = 11;

  const out = await wb.xlsx.writeBuffer();
  const filename = (state.fileName || 'overtime').replace(/\.xlsx$/i, '') + '-calculated.xlsx';
  const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
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
      const ab = e.target.result;
      state.originalBytes = ab;  // keep original bytes for in-place export
      const data = new Uint8Array(ab.slice(0));
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
  loadHolidaysFromStorage();
  // Display the count of active holidays so users can see they're loaded
  const countEl = document.getElementById('holiday-count');
  if (countEl) countEl.textContent = Object.keys(state.holidays).length.toLocaleString('ar-EG');

  // Refresh holidays when the user returns to this tab (they may have edited them on /holidays.html)
  window.addEventListener('focus', () => {
    loadHolidaysFromStorage();
    if (countEl) countEl.textContent = Object.keys(state.holidays).length.toLocaleString('ar-EG');
    recalcAndRender();
  });

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
    if (!el) return;
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
});
