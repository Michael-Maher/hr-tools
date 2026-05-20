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
    department: 'general',  // department key — drives worker/staff classification + per-dept rules
  },
  holidays: {},
};

// =============================================================================
// Departments
// =============================================================================
// Each dept declares a default role (worker/staff) plus per-name exceptions.
// Special rules:
//   - driverBonus:    OT computed as max(0, total_hours − 15) — replaces normal OT
//   - personOtStart:  { 'Name': 17.0 } — override the OT-start hour for that person
//   - exemptNames:    these employees never receive OT or day credits
//
// Role consequences:
//   - worker → holiday work earns the configured day credit (2 days)
//   - staff  → holiday work earns NO day credit (they get an alternative day off)
//   - exempt → row produces zeros (no OT, no credit, no sahar)
// =============================================================================
const DEPARTMENTS = [
  { key: 'general',          label: 'بدون قسم — قواعد عامة فقط',          defaultRole: 'worker' },
  { key: 'Transportation',   label: 'Transportation',   defaultRole: 'worker', driverBonus: true },
  { key: 'Security',         label: 'Security',         defaultRole: 'worker', staffNames: ['Tamer'] },
  { key: 'Finance',          label: 'Finance',          defaultRole: 'staff',  personOtStart: { 'Ahmed Ayman': 17.0 } },
  { key: 'Warehouses',       label: 'Warehouses',       defaultRole: 'worker', exemptNames: ['Khaled Amer', 'Safwat', 'Ayman'] },
  { key: 'Warehouses Sawah', label: 'Warehouses Sawah', defaultRole: 'worker', exemptNames: ['Khaled Amer', 'Safwat', 'Ayman'] },
  { key: 'Cafeteria',        label: 'Cafeteria',        defaultRole: 'worker' },
  { key: 'Buffet',           label: 'Buffet',           defaultRole: 'worker' },
  { key: 'Housekeeping',     label: 'Housekeeping',     defaultRole: 'worker' },
  { key: 'IT',               label: 'IT',               defaultRole: 'staff' },
  { key: 'R&D',              label: 'R&D',              defaultRole: 'staff',  workerNames: ['Ahmed Abdel Karim', 'Ahmed Abdelkareem'] },
  { key: 'QC',               label: 'QC',               defaultRole: 'staff',  workerNames: ['Tamer Ahmed', 'Magdy Ghomry', 'Mahmoud Hamed', 'Al Moatasem'] },
  { key: 'QA',               label: 'QA',               defaultRole: 'staff' },
  { key: 'Supply Chain',     label: 'Supply Chain',     defaultRole: 'staff' },
  { key: 'Engineering',      label: 'Engineering',      defaultRole: 'staff' },
  { key: 'EHS',              label: 'EHS',              defaultRole: 'staff' },
  { key: 'Production',       label: 'Production',       defaultRole: 'worker', staffNames: ['Youssef Ibrahim', 'Mahmoud Magdy', 'Abdelrahman Mohamed', 'Gouda'] },
];
const DEPT_BY_KEY = Object.fromEntries(DEPARTMENTS.map(d => [d.key, d]));

function normName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
// Loose substring match — handles "Tamer Ahmed" vs "Tamer", etc.
function nameMatchesAny(actual, list) {
  if (!list || !list.length) return false;
  const a = normName(actual);
  return list.some(n => {
    const e = normName(n);
    return e && (a.includes(e) || e.includes(a));
  });
}
function getDeptConfig() {
  return DEPT_BY_KEY[state.settings.department] || DEPT_BY_KEY.general;
}
function getEmployeeRole(empName, dept = getDeptConfig()) {
  if (!dept) return 'worker';
  if (nameMatchesAny(empName, dept.exemptNames)) return 'exempt';
  if (nameMatchesAny(empName, dept.workerNames)) return 'worker';
  if (nameMatchesAny(empName, dept.staffNames)) return 'staff';
  return dept.defaultRole || 'worker';
}
function getPersonOtStart(empName, dept = getDeptConfig()) {
  if (!dept?.personOtStart) return null;
  for (const [key, val] of Object.entries(dept.personOtStart)) {
    if (nameMatchesAny(empName, [key])) return val;
  }
  return null;
}

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
  // Returns: { approved, clarification, kind, role }
  const out = { approved: 0, clarification: 0, kind: 'regular', role: 'worker' };
  const s = state.settings;
  const dept = getDeptConfig();
  const role = getEmployeeRole(parsed.name, dept);
  out.role = role;

  // Exempt employees (e.g. Warehouses engineers) — never receive any OT/credit
  if (role === 'exempt') { out.kind = 'exempt'; return out; }

  const dateStr = fmtDate(parsed.date);
  const day = parsed.day || dayName(parsed.date);
  const isFriday = day === 'Friday';
  const isSaturday = day === 'Saturday';
  const holiday = state.holidays[dateStr];
  const breakHours = s.breakMinutes / 60;

  if (parsed.from == null || parsed.to == null) return out;
  const from = parsed.from;
  // Excel often stores end-of-day midnight as 0:00 (a `time(0,0)` cell). When that's
  // followed by a positive From, interpret the 0 as 24:00 so a normal 8:00 → 0:00
  // shift parses as a full sahar (16h gross, 7:30 OT) instead of returning early.
  let to = parsed.to;
  if (to < from && from > 0.01) to += 24;
  const work = to - from;
  if (work <= 0) return out;

  const isContinuation = from < 0.01;
  const endsAtMidnight = Math.abs(to - s.sahar.end) < 0.01;

  // Per-person OT start override (e.g. Ahmed Ayman in Finance → 17:00)
  const otStart = getPersonOtStart(parsed.name, dept) ?? s.shiftEnd;

  // ── Day credits ─────────────────────────────────────────────────────────
  // Fri/Sat need worked × 1.5 ≥ 8. Holidays only credit workers (staff get alt day off).
  // When a holiday falls on Fri/Sat, take the MAX credit (holiday's 2 vs Sat's 1).
  const minDayCreditHours = 3.5;
  const friSatGate = work * 1.5 >= 8;
  const holidayGate = isContinuation || work >= minDayCreditHours;
  let credit = 0;
  if (isFriday && friSatGate) credit = Math.max(credit, s.fridayDays);
  if (isSaturday && friSatGate) credit = Math.max(credit, s.saturdayDays);
  if (holiday && holidayGate && !isContinuation && role === 'worker') {
    credit = Math.max(credit, holiday.days);
  }
  out.clarification = credit;

  // ── Transportation: drivers receive max(0, total − 15) as OT, no sahar split ──
  if (dept.driverBonus) {
    if (isFriday) out.kind = 'friday';
    else if (isSaturday) out.kind = 'saturday';
    else if (holiday) out.kind = 'holiday';
    else if (isContinuation) out.kind = 'continuation';
    else out.kind = 'regular';
    const driverOt = Math.max(0, work - 15);
    if (driverOt >= s.minOtHours) out.approved = driverOt;
    return out;
  }

  // 1. Continuation morning checked first — a 0→24 row is a full overnight session,
  //    not just an evening sahar shift. The chain pass (linkContinuationChains) may
  //    later rewrite this when the previous row was a sahar.
  if (isContinuation) {
    out.kind = 'continuation';
    const fullCount = isFriday || isSaturday || !!holiday;
    let approved;
    if (to <= s.shiftStart + 0.001) {
      approved = 0;  // Fresh-midnight start, leaves by 8 AM — attendance only
    } else if (fullCount) {
      // Fri/Sat/Holiday cont: count all hours (only break deducted), capped at 15:30
      approved = Math.min(to - breakHours, s.continuationCap);
    } else if (to <= s.shiftEnd + 0.001) {
      // Weekday fresh-midnight start, leaving by 16:30 — exclude the 0-8 portion
      approved = Math.max(0, to - s.shiftStart - breakHours);
    } else {
      // Weekday cont staying past shift end — excl 0-8, capped
      approved = Math.min(s.continuationCap, to - s.shiftStart - breakHours);
    }
    if (approved < s.minOtHours) approved = 0;
    out.approved = approved;
    return out;
  }

  // 2. Sahar shift — full evening to midnight. Counts as 7:30 OT in Approved
  //    (matches confirmed files across Security, QC, Production, R&D, QA).
  //    The chain pass will redistribute when a continuation morning follows.
  if (endsAtMidnight) {
    out.kind = 'sahar';
    out.approved = s.sahar.total;
    return out;
  }

  // 3. Regular OT — past otStart (default 16:30, or 17:00 for some Finance staff)
  if (isFriday) out.kind = 'friday';
  else if (isSaturday) out.kind = 'saturday';
  else if (holiday) out.kind = 'holiday';
  const ot = Math.max(0, to - otStart);
  if (ot >= s.minOtHours) out.approved = ot;
  return out;
}

// When a continuation morning (From=0) follows a sahar evening on the previous day,
// re-distribute the OT between the two rows. Two patterns observed in confirmed HR
// files:
//   "lump"  (to ≤ 16:30 or exactly 24:00): morning absorbs the night → sahar=0,
//           morning = min(to − break, 15:30 cap)
//   "split" (16:30 < to < 24:00):           sahar keeps 7:30, morning excludes the
//                                           0-8 "don't count" window
function linkContinuationChains(emp) {
  const s = state.settings;
  for (let i = 1; i < emp.days.length; i++) {
    const cur = emp.days[i];
    const prev = emp.days[i - 1];
    if (!cur.calc || !prev.calc) continue;
    if (cur.calc.kind !== 'continuation' || prev.calc.kind !== 'sahar') continue;
    const t = cur.to;
    if (t == null) continue;
    if (t <= s.shiftEnd + 0.001 || Math.abs(t - s.sahar.end) < 0.01) {
      // lump: morning absorbs the night
      prev.calc.approved = 0;
      let mor = Math.min(t - s.breakMinutes / 60, s.continuationCap);
      if (mor < s.minOtHours) mor = 0;
      cur.calc.approved = mor;
    }
    // split: prev.calc.approved stays at 7:30 (already set by calculateRow), morning
    // keeps its excl-0-8 value
  }
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

// Compute totals + per-category breakdown for one employee. Centralised so
// processWorkbook and recalcAndRender stay in sync.
function computeEmployeeTotals(e) {
  let approved = 0, clarification = 0;
  let friDays = 0, satDays = 0, holDays = 0;
  let daysWorked = 0, otDays = 0, saharDays = 0;
  for (const d of e.days) {
    const c = d.calc;
    if (!c) continue;
    approved += c.approved;
    clarification += c.clarification;
    // Real work occurs when there's a non-negative duration; account for the To=0
    // (=24) wrap so 8:00 → 0:00 counts as worked.
    let workSpan = 0;
    if (d.from != null && d.to != null) {
      let tt = d.to;
      if (tt < d.from && d.from > 0.01) tt += 24;
      workSpan = tt - d.from;
    }
    if (workSpan > 0) daysWorked++;
    if (c.kind === 'sahar') saharDays++;
    if (c.approved > 0) otDays++;
    if (c.clarification > 0) {
      const dn = d.day || dayName(d.date);
      if (dn === 'Friday') friDays += c.clarification;
      else if (dn === 'Saturday') satDays += c.clarification;
      else holDays += c.clarification;
    }
  }
  return { approved, clarification, friDays, satDays, holDays, daysWorked, otDays, saharDays };
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

  // Compute calculations (two passes: per-row, then chain linking for sahar→cont)
  for (const e of employees) {
    for (const d of e.days) d.calc = calculateRow(d);
    linkContinuationChains(e);
    e.totals = computeEmployeeTotals(e);
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
    for (const d of e.days) d.calc = calculateRow(d);
    linkContinuationChains(e);
    e.totals = computeEmployeeTotals(e);
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
  const filterId = document.getElementById('emp-filter').value;
  const list = filterId
    ? state.employees.filter(e => String(e.id) === String(filterId))
    : state.employees;
  const totalEmp = list.length;
  let totApproved = 0, totClarif = 0;
  let totFri = 0, totSat = 0, totHol = 0;
  let totDaysWorked = 0, totSaharDays = 0;
  for (const e of list) {
    totApproved += e.totals.approved;
    totClarif += e.totals.clarification;
    totFri += e.totals.friDays;
    totSat += e.totals.satDays;
    totHol += e.totals.holDays;
    totDaysWorked += e.totals.daysWorked;
    totSaharDays += e.totals.saharDays;
  }
  const grid = document.getElementById('summary-grid');
  const empLabel = filterId ? 'الموظف المعروض' : 'عدد الموظفين';
  grid.innerHTML = `
    <div class="summary-card"><div class="num">${totalEmp}</div><div class="lbl">${empLabel}</div></div>
    <div class="summary-card amber"><div class="num">${totDaysWorked}</div><div class="lbl">أيام العمل الفعلية</div></div>
    <div class="summary-card green"><div class="num">${hoursToHHMM(totApproved) || '0:00'}</div><div class="lbl">إجمالي الأوفر تايم</div></div>
    <div class="summary-card purple"><div class="num">${totSaharDays}</div><div class="lbl">ليالي السهر</div></div>
    <div class="summary-card cyan"><div class="num">${totClarif}</div><div class="lbl">إجمالي أيام Clarification</div></div>
    <div class="summary-card emerald"><div class="num">${totFri}</div><div class="lbl">أيام الجمعات</div></div>
    <div class="summary-card sky"><div class="num">${totSat}</div><div class="lbl">أيام السبت</div></div>
    <div class="summary-card rose"><div class="num">${totHol}</div><div class="lbl">أيام الأعياد</div></div>
  `;
  // Per-employee detail panel — only when one employee is selected
  renderEmployeeDetail(filterId);
}

function renderEmployeeDetail(filterId) {
  const panel = document.getElementById('emp-detail');
  if (!panel) return;
  if (!filterId) { panel.innerHTML = ''; panel.classList.add('hidden'); return; }
  const e = state.employees.find(emp => String(emp.id) === String(filterId));
  if (!e) { panel.innerHTML = ''; panel.classList.add('hidden'); return; }
  const t = e.totals;
  const recordCount = e.days.length;
  const avgOt = t.otDays ? t.approved / t.otDays : 0;
  const role = getEmployeeRole(e.name);
  const roleLabel = role === 'exempt' ? 'معفي' : (role === 'staff' ? 'Staff' : 'Worker');
  panel.innerHTML = `
    <div class="emp-card">
      <div class="emp-head">
        <div>
          <div class="emp-name">${e.name} <span class="role-tag role-${role}">${roleLabel}</span></div>
          <div class="emp-id">ID: ${e.id}</div>
        </div>
        <div class="emp-meta">
          <span>${recordCount} سجل</span>
          <span>·</span>
          <span>${t.daysWorked} يوم عمل</span>
          ${t.otDays ? `<span>·</span><span>متوسط أوفر تايم/يوم: ${hoursToHHMM(avgOt)}</span>` : ''}
        </div>
      </div>
      <div class="emp-stats">
        <div class="estat"><div class="estat-num">${hoursToHHMM(t.approved) || '0:00'}</div><div class="estat-lbl">إجمالي الأوفر تايم</div></div>
        <div class="estat purple"><div class="estat-num">${t.saharDays}</div><div class="estat-lbl">ليالي السهر</div></div>
        <div class="estat emerald"><div class="estat-num">${t.friDays}</div><div class="estat-lbl">أيام جمعة</div></div>
        <div class="estat sky"><div class="estat-num">${t.satDays}</div><div class="estat-lbl">أيام سبت</div></div>
        <div class="estat rose"><div class="estat-num">${t.holDays}</div><div class="estat-lbl">أيام أعياد</div></div>
      </div>
    </div>
  `;
  panel.classList.remove('hidden');
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
      else if (calc.kind === 'exempt') { tag = '<span class="tag tag-exempt">معفي</span>'; rowClass = 'exempt'; }
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
function setCellWithFormat(cell, value, numFmt, refFont) {
  // Build the plain style object first, then assign — this avoids ExcelJS losing the
  // numFmt override when cell.numFmt is set after a style-object assignment.
  const style = cell.style ? JSON.parse(JSON.stringify(cell.style)) : {};
  if (value != null) style.numFmt = numFmt;
  // Inherit the row's font color (e.g. red text) so values we write match the rest
  // of the row. The H/I/J cells in the raw file are often empty (no font at all) or
  // carry a default font without a color — both cases would render black otherwise.
  if (refFont) {
    if (!style.font) {
      style.font = JSON.parse(JSON.stringify(refFont));
    } else if (refFont.color && !style.font.color) {
      style.font = { ...style.font, color: JSON.parse(JSON.stringify(refFont.color)) };
    }
  }
  cell.value = value;
  cell.style = style;
}

// Pick a reference font for this row by looking at the first column that carries one.
// Falls back to the row's default font.
function rowRefFont(ws, r) {
  for (const col of [4, 1, 2, 3, 5, 6, 7]) {
    const c = ws.getCell(r, col);
    if (c && c.font) return JSON.parse(JSON.stringify(c.font));
  }
  const row = ws.getRow(r);
  return row.font ? JSON.parse(JSON.stringify(row.font)) : null;
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
        const totRefFont = rowRefFont(ws, r);
        const hT = ws.getCell(r, 8);
        const iT = ws.getCell(r, 9);
        setCellWithFormat(hT, tot.approved ? tot.approved / 24 : null, '[h]:mm', totRefFont);
        setCellWithFormat(iT, tot.clarification || null, '0', totRefFont);
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

    // Set Approved (H), Clarification (I)
    const hCell = ws.getCell(r, 8);
    const iCell = ws.getCell(r, 9);
    // Pull the row's font (from Name/Day cells) so red-row text stays red in H/I too
    const refFont = rowRefFont(ws, r);

    setCellWithFormat(hCell, calc.approved ? calc.approved / 24 : null, '[h]:mm', refFont);
    // Clarification holds a day count (1, 2, 3) — force integer format so the cell
    // can't be misread as a time fraction (Excel renders "1" as "24:00" when a time
    // number-format is inherited from a sibling cell's shared style).
    setCellWithFormat(iCell, calc.clarification || null, '0', refFont);
  }

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
  initBatchMode();
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

  // Department selector — populate, restore saved choice, wire change handler
  const deptSel = document.getElementById('s-dept');
  if (deptSel) {
    deptSel.innerHTML = '';
    for (const d of DEPARTMENTS) {
      const opt = document.createElement('option');
      opt.value = d.key;
      opt.textContent = d.label;
      deptSel.appendChild(opt);
    }
    const saved = localStorage.getItem('hr-tools.department') || 'general';
    deptSel.value = DEPT_BY_KEY[saved] ? saved : 'general';
    state.settings.department = deptSel.value;
    renderDeptInfo();
    deptSel.addEventListener('change', () => {
      state.settings.department = deptSel.value;
      localStorage.setItem('hr-tools.department', deptSel.value);
      renderDeptInfo();
      recalcAndRender();
    });
  }
});

// ---------- department info panel ----------
function renderDeptInfo() {
  const panel = document.getElementById('dept-info');
  if (!panel) return;
  const dept = getDeptConfig();
  if (!dept || dept.key === 'general') {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  const rules = [];
  if (dept.defaultRole === 'staff') rules.push('الأصل: <b>Staff</b> — مفيش credit للأعياد (بدل راحة بدلها)');
  else rules.push('الأصل: <b>Worker</b> — credit الأعياد بيتطبق');
  if (dept.driverBonus) rules.push('🚚 Drivers OT = <code>max(0, إجمالي الساعات − 15)</code>');
  if (dept.saharAsOt) rules.push('🌙 شيفت السهر بيتسجّل OT في <b>Approved</b> مش في Night');
  if (dept.personOtStart) {
    for (const [n, h] of Object.entries(dept.personOtStart)) {
      const hh = Math.floor(h); const mm = Math.round((h - hh) * 60);
      rules.push(`⏰ <b>${n}</b>: OT يبدأ من ${pad(hh)}:${pad(mm)}`);
    }
  }
  const lists = [];
  if (dept.workerNames?.length) lists.push(`<div class="dept-people"><span class="role-tag role-worker">Worker</span> ${dept.workerNames.map(n => `<span class="dept-name">${n}</span>`).join('')}</div>`);
  if (dept.staffNames?.length)  lists.push(`<div class="dept-people"><span class="role-tag role-staff">Staff</span> ${dept.staffNames.map(n => `<span class="dept-name">${n}</span>`).join('')}</div>`);
  if (dept.exemptNames?.length) lists.push(`<div class="dept-people"><span class="role-tag role-exempt">معفي</span> ${dept.exemptNames.map(n => `<span class="dept-name">${n}</span>`).join('')}</div>`);

  panel.innerHTML = `
    <div class="dept-info-box">
      <div class="dept-info-title">📋 قواعد قسم ${dept.label}</div>
      <ul class="dept-rules">${rules.map(r => `<li>${r}</li>`).join('')}</ul>
      ${lists.join('')}
    </div>
  `;
  panel.classList.remove('hidden');
}

// =============================================================================
// BATCH MODE — multi-department upload + overall factory sheet
// =============================================================================
const batch = {
  mode: 'single',          // 'single' | 'batch'
  depts: [],               // [{ slotId, deptKey, file, bytes, fileName, employees, processed, error }]
  overall: null,           // { file, bytes, fileName, rowCount }
  overallOutBytes: null,   // ArrayBuffer of the calculated overall workbook
  nextSlotId: 1,
};

function initBatchMode() {
  // Mode toggle buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setBatchMode(btn.dataset.mode));
  });
  // Seed batch mode with a couple of empty slots so the UI isn't blank
  addDeptSlot(); addDeptSlot();

  document.getElementById('btn-add-dept').addEventListener('click', () => {
    if (batch.depts.length >= 16) return;
    addDeptSlot();
    renderBatchDepts();
  });

  // Overall sheet dropzone
  const odz = document.getElementById('batch-overall-dz');
  const ofi = document.getElementById('batch-overall-input');
  odz.addEventListener('click', () => ofi.click());
  odz.addEventListener('dragover', (e) => { e.preventDefault(); odz.classList.add('drag'); });
  odz.addEventListener('dragleave', () => odz.classList.remove('drag'));
  odz.addEventListener('drop', (e) => {
    e.preventDefault();
    odz.classList.remove('drag');
    if (e.dataTransfer.files.length) loadOverallFile(e.dataTransfer.files[0]);
  });
  ofi.addEventListener('change', () => { if (ofi.files[0]) loadOverallFile(ofi.files[0]); });

  document.getElementById('btn-batch-process').addEventListener('click', batchProcessAll);
  document.getElementById('btn-batch-download-overall').addEventListener('click', batchDownloadOverall);
}

function setBatchMode(mode) {
  batch.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('single-mode').classList.toggle('hidden', mode !== 'single');
  document.getElementById('batch-mode').classList.toggle('hidden', mode !== 'batch');
  if (mode === 'batch') renderBatchDepts();
}

function addDeptSlot() {
  batch.depts.push({
    slotId: 'd' + (batch.nextSlotId++),
    deptKey: 'general',
    file: null,
    bytes: null,
    fileName: '',
    employees: [],
    processed: false,
    error: null,
  });
}

function renderBatchDepts() {
  const wrap = document.getElementById('batch-depts');
  wrap.innerHTML = '';
  batch.depts.forEach((slot, i) => {
    const div = document.createElement('div');
    div.className = 'dept-slot' + (slot.processed ? ' processed' : '') + (slot.error ? ' error' : '');
    div.dataset.slotId = slot.slotId;
    const deptOptions = DEPARTMENTS.map(d =>
      `<option value="${d.key}" ${d.key === slot.deptKey ? 'selected' : ''}>${d.label}</option>`
    ).join('');
    const fname = slot.fileName
      ? `<span class="fname">${slot.fileName}</span>`
      : '<span class="fname empty">لم يتم رفع ملف</span>';
    let meta = '';
    if (slot.error) meta = `<span class="meta">⚠ ${slot.error}</span>`;
    else if (slot.processed) meta = `<span class="meta">✓ ${slot.employees.length} موظف</span>`;
    else if (slot.bytes) meta = `<span class="meta">جاهز للحساب</span>`;
    div.innerHTML = `
      <div class="dept-slot-num">${i + 1}</div>
      <select data-action="dept">${deptOptions}</select>
      <div class="dept-slot-file">
        <label>📂 رفع/تغيير<input type="file" accept=".xlsx" data-action="upload"></label>
        ${fname}
      </div>
      ${meta}
      <div class="dept-slot-actions">
        ${slot.processed ? '<button class="btn btn-success btn-sm" data-action="download">⬇</button>' : ''}
        <button class="btn btn-danger btn-sm" data-action="remove" title="حذف">✕</button>
      </div>
    `;
    div.querySelector('[data-action="dept"]').addEventListener('change', (e) => {
      slot.deptKey = e.target.value;
      slot.processed = false;  // dept change invalidates prior calc
      slot.employees = [];
      slot.error = null;
      renderBatchDepts();
      updateBatchProcessButton();
    });
    div.querySelector('[data-action="upload"]').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) loadDeptFile(slot, f);
    });
    div.querySelector('[data-action="remove"]').addEventListener('click', () => {
      batch.depts = batch.depts.filter(s => s.slotId !== slot.slotId);
      renderBatchDepts();
      updateBatchProcessButton();
    });
    const dlBtn = div.querySelector('[data-action="download"]');
    if (dlBtn) dlBtn.addEventListener('click', () => batchDownloadDept(slot));
    wrap.appendChild(div);
  });
  updateBatchProcessButton();
}

function loadDeptFile(slot, file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    slot.bytes = e.target.result;
    slot.file = file;
    slot.fileName = file.name;
    slot.processed = false;
    slot.employees = [];
    slot.error = null;
    renderBatchDepts();
  };
  reader.readAsArrayBuffer(file);
}

function loadOverallFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    batch.overall = {
      file,
      bytes: e.target.result,
      fileName: file.name,
      rowCount: 0,
    };
    // Quick parse to count rows (best-effort)
    try {
      const data = new Uint8Array(e.target.result.slice(0));
      const wb = XLSX.read(data, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const ref = ws['!ref'];
      if (ref) {
        const range = XLSX.utils.decode_range(ref);
        batch.overall.rowCount = Math.max(0, range.e.r - 1);  // minus header
      }
    } catch { /* ignore */ }
    const el = document.getElementById('batch-overall-status');
    el.innerHTML = `<span>${file.name}</span> <strong>·</strong> <span>~${batch.overall.rowCount} موظف</span>`;
    el.classList.remove('hidden');
    batch.overallOutBytes = null;
    document.getElementById('btn-batch-download-overall').disabled = true;
    updateBatchProcessButton();
  };
  reader.readAsArrayBuffer(file);
}

function updateBatchProcessButton() {
  const hasDept = batch.depts.some(s => s.bytes);
  const hasOverall = batch.overall && batch.overall.bytes;
  document.getElementById('btn-batch-process').disabled = !(hasDept && hasOverall);
}

async function batchProcessAll() {
  const btn = document.getElementById('btn-batch-process');
  btn.disabled = true;
  btn.textContent = '⏳ جاري الحساب…';
  try {
    // Process each dept slot
    let totalEmps = 0, totalDays = 0;
    const savedDept = state.settings.department;
    for (const slot of batch.depts) {
      if (!slot.bytes) continue;
      try {
        state.settings.department = slot.deptKey;
        const data = new Uint8Array(slot.bytes.slice(0));
        const wb = XLSX.read(data, { type: 'array', cellDates: true });
        const employees = processWorkbookFor(wb);
        slot.employees = employees;
        slot.processed = true;
        slot.error = null;
        totalEmps += employees.length;
        totalDays += employees.reduce((a, e) => a + e.days.length, 0);
      } catch (err) {
        console.error(err);
        slot.error = err.message || 'فشل القراءة';
        slot.processed = false;
      }
    }
    state.settings.department = savedDept;

    // Fill the overall sheet
    let filledRows = 0, unmatchedIds = 0;
    if (batch.overall && batch.overall.bytes) {
      const result = await fillOverallSheet();
      batch.overallOutBytes = result.bytes;
      filledRows = result.filled;
      unmatchedIds = result.unmatched;
      document.getElementById('btn-batch-download-overall').disabled = false;
    }
    renderBatchDepts();
    renderBatchSummary(totalEmps, totalDays, filledRows, unmatchedIds);
  } finally {
    btn.textContent = '▶ ابدأ الحساب';
    updateBatchProcessButton();
  }
}

// Parse + calculate one workbook and return the employees array (without mutating
// global state.employees). Mirrors processWorkbook() but returns local data.
function processWorkbookFor(wb) {
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = parseSheet(ws);
  const cv = (c) => (c && typeof c === 'object' && 'v' in c) ? c.v : c;
  const employees = [];
  let cur = null;
  for (let i = 6; i < rows.length; i++) {
    const r = rows[i];
    const dayVal = cv(r[0]);
    const idVal = cv(r[2]);
    const nameVal = cv(r[3]);
    if (dayVal == null && idVal == null && nameVal == null) continue;
    if (typeof dayVal === 'string' && /total/i.test(dayVal)) {
      if (cur) { cur.totalRowIndex = i; employees.push(cur); cur = null; }
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
  for (const e of employees) {
    for (const d of e.days) d.calc = calculateRow(d);
    linkContinuationChains(e);
    e.totals = computeEmployeeTotals(e);
  }
  return employees;
}

// Read overall factory sheet, locate each row by ID, write totals into the
// "Submitted extra working days" (G) and "Submitted extra working hours" (I) columns.
// Returns { bytes, filled, unmatched }.
async function fillOverallSheet() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(batch.overall.bytes);
  // Build (id → totals) map across ALL depts
  const byId = new Map();
  for (const slot of batch.depts) {
    if (!slot.processed) continue;
    for (const e of slot.employees) {
      byId.set(String(e.id).trim(), {
        hours: e.totals.approved,
        days: e.totals.clarification,
      });
    }
  }
  let filled = 0;
  const matchedIds = new Set();
  for (const ws of wb.worksheets) {
    // Look for ID and submission columns in the header row
    let idCol = 0, daysCol = 0, hoursCol = 0;
    for (let c = 1; c <= ws.columnCount; c++) {
      const hv = String(ws.getCell(1, c).value || '').toLowerCase();
      if (hv === 'id' && !idCol) idCol = c;
      if (hv.includes('submitted') && hv.includes('working days') && !daysCol) daysCol = c;
      if (hv.includes('submitted') && hv.includes('working hours') && !hoursCol) hoursCol = c;
    }
    if (!idCol) continue;  // not a roster sheet
    for (let r = 2; r <= ws.rowCount; r++) {
      const idVal = ws.getCell(r, idCol).value;
      if (idVal == null) continue;
      const key = String(idVal).trim();
      const m = byId.get(key);
      if (!m) continue;
      matchedIds.add(key);
      const refFont = rowRefFont(ws, r);
      if (daysCol && m.days) {
        setCellWithFormat(ws.getCell(r, daysCol), m.days, '0', refFont);
      }
      if (hoursCol && m.hours) {
        setCellWithFormat(ws.getCell(r, hoursCol), m.hours / 24, '[h]:mm', refFont);
      }
      filled++;
    }
  }
  const unmatched = byId.size - matchedIds.size;
  const bytes = await wb.xlsx.writeBuffer();
  return { bytes, filled, unmatched };
}

function batchDownloadDept(slot) {
  if (!slot.bytes || !slot.processed) return;
  // Reuse the existing exportXlsx by temporarily swapping state, then restore.
  const saved = {
    employees: state.employees,
    originalBytes: state.originalBytes,
    fileName: state.fileName,
    department: state.settings.department,
  };
  state.employees = slot.employees;
  state.originalBytes = slot.bytes;
  state.fileName = slot.fileName;
  state.settings.department = slot.deptKey;
  exportXlsx().finally(() => {
    state.employees = saved.employees;
    state.originalBytes = saved.originalBytes;
    state.fileName = saved.fileName;
    state.settings.department = saved.department;
  });
}

function batchDownloadOverall() {
  if (!batch.overallOutBytes) return;
  const filename = (batch.overall.fileName || 'overall').replace(/\.xlsx$/i, '') + '-calculated.xlsx';
  const blob = new Blob([batch.overallOutBytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

function renderBatchSummary(totalEmps, totalDays, filledRows, unmatchedIds) {
  const el = document.getElementById('batch-summary');
  const processedDepts = batch.depts.filter(s => s.processed).length;
  const hasOverall = !!batch.overallOutBytes;
  el.innerHTML = `
    <div class="batch-stats">
      <div class="batch-stat"><div class="batch-stat-num">${processedDepts}</div><div class="batch-stat-lbl">قسم اتحسب</div></div>
      <div class="batch-stat"><div class="batch-stat-num">${totalEmps}</div><div class="batch-stat-lbl">إجمالي الموظفين</div></div>
      <div class="batch-stat"><div class="batch-stat-num">${totalDays}</div><div class="batch-stat-lbl">إجمالي الأيام</div></div>
      ${hasOverall ? `<div class="batch-stat"><div class="batch-stat-num">${filledRows}</div><div class="batch-stat-lbl">صف اتعبّى في شيت المصنع</div></div>` : ''}
    </div>
    ${unmatchedIds > 0
      ? `<div class="batch-warn">⚠ في ${unmatchedIds} موظف من شيتات الأقسام مالقاش له صف في شيت المصنع — تأكد إن الـ IDs متطابقة.</div>`
      : ''}
  `;
  el.classList.remove('hidden');
}
