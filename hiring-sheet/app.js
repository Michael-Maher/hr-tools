/* ============================================================
   HR Tools — Hiring Sheet
   ============================================================ */

'use strict';

// ───────── state ─────────
const files = { front: null, back: null, cv: null };
const rawText = { front: '', back: '', cv: '' };
let entries = [];

// ───────── DOM ─────────
const $ = (id) => document.getElementById(id);
const els = {
  fileFront: $('file-front'), fileBack: $('file-back'), fileCv: $('file-cv'),
  upFront: $('up-front'), upBack: $('up-back'), upCv: $('up-cv'),
  btnExtract: $('btn-extract'),
  ocrStatus: $('ocr-status'),
  ocrRaw: $('ocr-raw'),
  rawFront: $('raw-front'), rawBack: $('raw-back'), rawCv: $('raw-cv'),
  fNameAr: $('f-name-ar'), fNameEn: $('f-name-en'),
  fNid: $('f-nid'), fDob: $('f-dob'), fExpiry: $('f-expiry'),
  fReligion: $('f-religion'), fGender: $('f-gender'), fGov: $('f-gov'),
  fEmail: $('f-email'), fPhone: $('f-phone'), fAddress: $('f-address'),
  nidHint: $('nid-hint'),
  btnAdd: $('btn-add'), btnClear: $('btn-clear'), formStatus: $('form-status'),
  rowCount: $('row-count'),
  fileImport: $('file-import'), btnExport: $('btn-export'), btnClearAll: $('btn-clear-all'),
  tableStatus: $('table-status'),
  tableBody: document.querySelector('#data-table tbody'),
  emptyState: $('empty-state'),
};

// ───────── Egyptian National ID parsing ─────────
const GOVERNORATES = {
  '01':'القاهرة','02':'الإسكندرية','03':'بورسعيد','04':'السويس',
  '11':'دمياط','12':'الدقهلية','13':'الشرقية','14':'القليوبية',
  '15':'كفر الشيخ','16':'الغربية','17':'المنوفية','18':'البحيرة',
  '19':'الإسماعيلية','21':'الجيزة','22':'بني سويف','23':'الفيوم',
  '24':'المنيا','25':'أسيوط','26':'سوهاج','27':'قنا','28':'أسوان',
  '29':'الأقصر','31':'البحر الأحمر','32':'الوادي الجديد','33':'مطروح',
  '34':'شمال سيناء','35':'جنوب سيناء','88':'خارج جمهورية مصر'
};

function parseNationalId(id) {
  if (!/^\d{14}$/.test(id)) return null;
  const c = id[0];
  if (c !== '2' && c !== '3') return null;
  const base = c === '2' ? 1900 : 2000;
  const yy = +id.slice(1, 3), mm = +id.slice(3, 5), dd = +id.slice(5, 7);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(base + yy, mm - 1, dd);
  if (d.getFullYear() !== base + yy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  const govCode = id.slice(7, 9);
  const gov = GOVERNORATES[govCode] || '';
  const gender = (+id[12]) % 2 === 1 ? 'ذكر' : 'أنثى';
  const dob = `${base + yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
  return { dob, gender, gov, govCode };
}

// ───────── digit normalization ─────────
function normalizeDigits(s) {
  if (!s) return '';
  return s
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

// ───────── upload UI ─────────
function bindUpload(kind, inputEl, cardEl) {
  inputEl.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    files[kind] = f;
    showPreview(kind, cardEl, f);
    refreshExtractBtn();
  });
  // clear button (delegate)
  cardEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('clear-btn')) {
      e.preventDefault();
      e.stopPropagation();
      files[kind] = null;
      rawText[kind] = null;
      const prev = cardEl.querySelector('.upload-preview');
      const img = prev.querySelector('img');
      img.src = '';
      prev.classList.add('hidden');
      cardEl.classList.remove('has-file');
      inputEl.value = '';
      refreshExtractBtn();
    }
  });
}

function showPreview(kind, cardEl, file) {
  const prev = cardEl.querySelector('.upload-preview');
  const img = prev.querySelector('img');
  if (file.type === 'application/pdf') {
    // show pdf icon-ish placeholder
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 200">
        <rect width="160" height="200" fill="#fff"/>
        <rect x="20" y="20" width="120" height="160" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
        <text x="80" y="110" text-anchor="middle" font-size="36" font-weight="bold" fill="#dc2626">PDF</text>
        <text x="80" y="145" text-anchor="middle" font-size="11" fill="#7f1d1d">${escapeXml(file.name).slice(0,18)}</text>
      </svg>`
    );
    prev.classList.remove('hidden');
    cardEl.classList.add('has-file');
  } else {
    const reader = new FileReader();
    reader.onload = (ev) => {
      img.src = ev.target.result;
      prev.classList.remove('hidden');
      cardEl.classList.add('has-file');
    };
    reader.readAsDataURL(file);
  }
}

function escapeXml(s) {
  return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
}

bindUpload('front', els.fileFront, els.upFront);
bindUpload('back',  els.fileBack,  els.upBack);
bindUpload('cv',    els.fileCv,    els.upCv);

function refreshExtractBtn() {
  els.btnExtract.disabled = !(files.front || files.back || files.cv);
}

// ───────── OCR (Tesseract.js v5 — high-level API + image preprocessing) ─────────
let _workerStatusCb = null;

// Upscale small images + grayscale + contrast bump → noticeable accuracy gain
async function preprocessImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('failed to load image'));
      im.src = url;
    });
    const MIN_W = 1800; // ~300+ DPI for typical ID card
    const scale = img.naturalWidth < MIN_W ? MIN_W / img.naturalWidth : 1;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    const contrast = 1.25; // gentler than before — too aggressive wipes faint Arabic text
    const intercept = 128 * (1 - contrast);
    for (let i = 0; i < px.length; i += 4) {
      const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const v = Math.max(0, Math.min(255, g * contrast + intercept));
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    ctx.putImageData(data, 0, 0);
    return await new Promise(r => canvas.toBlob(r, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function ocrImage(fileOrBlob, langs) {
  const processed = await preprocessImage(fileOrBlob);
  // Simple high-level API: rock-solid, default fast traineddata (~1-2MB per lang)
  const { data } = await Tesseract.recognize(processed, langs, {
    logger: (m) => { if (_workerStatusCb) _workerStatusCb(m); },
  });
  return data.text || '';
}

async function pdfToText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map(it => it.str).join(' ') + '\n';
  }
  return out;
}

async function extractCvText(file) {
  if (file.type === 'application/pdf') {
    const txt = await pdfToText(file);
    // Image-only PDF → render page 1 and OCR it
    if (txt.replace(/\s+/g, '').length > 40) return txt;
    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      return await ocrImage(blob, 'eng');
    } catch {
      return txt;
    }
  }
  return await ocrImage(file, 'eng');
}

// ───────── extraction heuristics ─────────
function find14DigitId(text) {
  const n = normalizeDigits(text);
  // 1. strict — contiguous 14 digits
  const strict = n.match(/(?<!\d)(\d{14})(?!\d)/);
  if (strict) {
    const parsed = parseNationalId(strict[1]);
    if (parsed) return strict[1];
  }
  // 2. tolerant — collapse "digit (space/punct) digit ..." clusters into one digit run
  //    Tesseract often outputs the ID as "2 9 5 0 9 0 9 0 1 2 3 4 5 6" or with random punctuation
  const collapsed = n.replace(/(\d)[\s\-_,.·•]+(?=\d)/g, '$1');
  const looseMatches = collapsed.match(/\d{14}/g) || [];
  for (const candidate of looseMatches) {
    if (parseNationalId(candidate)) return candidate; // first VALID one wins
  }
  // 3. last-resort — longest digit run >= 14, trimmed
  const runs = (collapsed.match(/\d{14,}/g) || []).sort((a, b) => b.length - a.length);
  for (const r of runs) {
    for (let i = 0; i <= r.length - 14; i++) {
      const slice = r.slice(i, i + 14);
      if (parseNationalId(slice)) return slice;
    }
  }
  // 4. ANY 14-digit run, even if NID parse fails (better than nothing)
  if (looseMatches[0]) return looseMatches[0];
  return '';
}

function findDatesIso(text) {
  const n = normalizeDigits(text);
  // patterns: dd/mm/yyyy  dd-mm-yyyy  yyyy/mm/dd
  const out = [];
  const re1 = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/g;
  let m;
  while ((m = re1.exec(n))) {
    const d = +m[1], mo = +m[2], y = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100) {
      out.push(`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    }
  }
  const re2 = /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/g;
  while ((m = re2.exec(n))) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100) {
      out.push(`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
    }
  }
  return out;
}

function findReligion(text) {
  if (/مسيح/.test(text)) return 'مسيحي';
  if (/مسلم|اسلام|إسلام/.test(text)) return 'مسلم';
  return '';
}

function findEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : '';
}

function findPhone(text) {
  const n = normalizeDigits(text);
  // Egypt: +20 1[0125]xxxxxxxx, 002 prefix, 01[0125]xxxxxxxx
  let m = n.match(/(?:\+20|0020|002)\s?1[0125]\d{8}/);
  if (m) return '+20' + m[0].replace(/\D/g, '').slice(-10);
  m = n.match(/\b01[0125]\d{8}\b/);
  if (m) return m[0];
  // any 11-digit starting 01
  m = n.match(/\b0\d{10}\b/);
  if (m) return m[0];
  return '';
}

function findEnglishName(text) {
  // Look at first 25 non-empty lines, pick the first that:
  //  - has 2..5 words
  //  - mostly Latin letters
  //  - not an email/phone/url/title-keyword
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 25);
  const bad = /(curriculum|vitae|resume|profile|address|phone|mobile|email|linkedin|github|@|http|www|\d)/i;
  for (const ln of lines) {
    if (bad.test(ln)) continue;
    const words = ln.split(/\s+/).filter(w => /^[A-Za-z][A-Za-z'.\-]+$/.test(w));
    if (words.length >= 2 && words.length <= 5 && words.join(' ').length === ln.length) {
      return words.join(' ');
    }
  }
  return '';
}

function findArabicNameLines(text) {
  // Return likely name candidates from front of ID:
  // lines made mostly of Arabic letters, 2+ words, not address/title-like
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const addressKw = /(شارع|محافظة|مدينة|قسم|مركز|حي|ميدان|عمارة|طريق|طنطا|الإسكندرية|القاهرة|الجيزة)/;
  // Standard ID-card boilerplate that's not a person's name
  const titleKw = /(جمهورية|العربية|بطاقة|تحقيق|الشخصية|الرقم|القومي|محل|الإقامة|الميلاد|تاريخ|الديانة|المهنة|الإصدار|الانتهاء|النوع|الحالة|الاجتماعية)/;
  const cands = [];
  for (const ln of lines) {
    const letters = (ln.match(/[؀-ۿ]/g) || []).length;
    const nonLetters = ln.length - letters;
    if (letters < 6) continue;
    if (nonLetters > letters * 0.5) continue;
    if (addressKw.test(ln)) continue;
    if (titleKw.test(ln)) continue;
    if (/\d/.test(ln)) continue;
    const words = ln.split(/\s+/).filter(w => /[؀-ۿ]/.test(w));
    if (words.length >= 2) cands.push(ln);
  }
  return cands;
}

function findArabicAddressLine(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const kw = /(شارع|محافظة|مدينة|قسم|مركز|حي|ميدان|عمارة|طريق)/;
  // prefer the longest matching line
  const matches = lines.filter(l => kw.test(l)).sort((a,b) => b.length - a.length);
  return matches[0] || '';
}

// ───────── extract pipeline ─────────
async function runExtraction() {
  els.btnExtract.disabled = true;
  els.ocrStatus.className = 'status working';
  els.ocrStatus.textContent = 'بنحمّل لغة العربي (أول مرة بس، ~13MB، بعد كده هتبقى محفوظة)...';

  _workerStatusCb = (m) => {
    if (m.status === 'loading language traineddata' || m.status === 'downloading') {
      const pct = Math.round((m.progress || 0) * 100);
      els.ocrStatus.textContent = `بنحمّل ${m.status === 'downloading' ? 'البيانات' : 'لغة العربي'} ... ${pct}%`;
    } else if (m.status === 'initializing api' || m.status === 'initialized api') {
      els.ocrStatus.textContent = 'بنجهّز المحرك...';
    } else if (m.status === 'recognizing text') {
      const pct = Math.round((m.progress || 0) * 100);
      els.ocrStatus.textContent = `بنقرأ النص... ${pct}%`;
    }
  };

  try {
    const tasks = [];
    if (files.front) tasks.push(ocrImage(files.front, 'ara+eng').then(t => rawText.front = t));
    if (files.back)  tasks.push(ocrImage(files.back,  'ara+eng').then(t => rawText.back  = t));
    if (files.cv)    tasks.push(extractCvText(files.cv).then(t => rawText.cv = t));
    await Promise.all(tasks);

    renderRawText('rawFront', rawText.front);
    renderRawText('rawBack',  rawText.back);
    renderRawText('rawCv',    rawText.cv);
    els.ocrRaw.classList.remove('hidden');
    // force-open the <details> panel so user immediately sees the raw text
    const det = els.ocrRaw.querySelector('details');
    if (det) det.open = true;

    const filled = fillFormFromRaw();
    const totalChars = (rawText.front || '').length + (rawText.back || '').length + (rawText.cv || '').length;

    if (filled.length === 0) {
      els.ocrStatus.className = 'status error';
      els.ocrStatus.textContent = totalChars < 30
        ? '⚠ قراءة الصور طلعت فاضية أو شبه فاضية. جرّب صورة أوضح، أو اكتب البيانات يدوي.'
        : `⚠ قرينا ${totalChars} حرف بس مقدرناش نطلّع منهم بيانات منظمة. شوف "النص الخام" تحت — اضغط على أي سطر عشان تحطه في حقل.`;
    } else {
      els.ocrStatus.className = 'status success';
      els.ocrStatus.textContent = `✓ تم تعبئة ${filled.length} حقل تلقائياً: ${filled.join('، ')}. راجع الباقي وعدّل اللي محتاج.`;
    }
  } catch (err) {
    console.error(err);
    els.ocrStatus.className = 'status error';
    els.ocrStatus.textContent = '⚠ حصلت مشكلة وقت قراءة الصور: ' + (err.message || err);
  } finally {
    els.btnExtract.disabled = false;
    _workerStatusCb = null;
  }
}

function fillFormFromRaw() {
  const filled = [];
  const set = (el, val, label) => {
    if (val && !el.value) { el.value = val; filled.push(label); return true; }
    return false;
  };

  // 1. National ID — try back first (clearer area), then front
  const nid = find14DigitId(rawText.back) || find14DigitId(rawText.front);
  if (nid && !els.fNid.value) {
    els.fNid.value = nid;
    onNidChange();
    filled.push('الرقم القومي');
    if (els.fDob.value) filled.push('تاريخ الميلاد');
    if (els.fGender.value) filled.push('النوع');
    if (els.fGov.value) filled.push('المحافظة');
  }
  // 2. Religion (back)
  set(els.fReligion, findReligion(rawText.back), 'الديانة');
  // 3. Expiry (back) — latest year date
  const backDates = findDatesIso(rawText.back).sort();
  if (backDates.length) set(els.fExpiry, backDates[backDates.length - 1], 'الانتهاء');
  // 4. Address (front)
  set(els.fAddress, findArabicAddressLine(rawText.front), 'العنوان');
  // 5. Arabic name (front)
  const arNames = findArabicNameLines(rawText.front);
  if (arNames.length) {
    set(els.fNameAr, arNames.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim(), 'الاسم بالعربي');
  }
  // 6. CV: english name, email, phone
  if (rawText.cv) {
    set(els.fNameEn, findEnglishName(rawText.cv), 'الاسم بالإنجليزي');
    set(els.fEmail,  findEmail(rawText.cv),       'الإيميل');
    set(els.fPhone,  findPhone(rawText.cv),       'التليفون');
  }
  return filled;
}

els.btnExtract.addEventListener('click', runExtraction);

// ───────── click-to-fill from raw text ─────────
// Each non-empty line in the raw panels becomes clickable;
// clicking opens a tiny picker offering all form fields.
const FIELD_PICKER = [
  { key: 'fNameAr',  label: 'الاسم بالعربي' },
  { key: 'fNameEn',  label: 'الاسم بالإنجليزي' },
  { key: 'fNid',     label: 'الرقم القومي (يمسح كل اللي مش رقم)' },
  { key: 'fAddress', label: 'العنوان' },
  { key: 'fEmail',   label: 'الإيميل' },
  { key: 'fPhone',   label: 'التليفون (يمسح كل اللي مش رقم)' },
];

function renderRawText(targetKey, text) {
  const el = els[targetKey];
  el.innerHTML = '';
  if (!text || !text.trim()) {
    el.textContent = '—';
    return;
  }
  // build clickable lines
  const lines = text.split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      el.appendChild(document.createTextNode('\n'));
      return;
    }
    const span = document.createElement('span');
    span.className = 'raw-line';
    span.textContent = line;
    span.title = 'اضغط لتعبئة حقل بالنص ده';
    span.addEventListener('click', () => openFieldPicker(span, trimmed));
    el.appendChild(span);
  });
}

function openFieldPicker(anchor, text) {
  // remove any existing picker
  document.querySelectorAll('.field-picker').forEach(p => p.remove());
  const picker = document.createElement('div');
  picker.className = 'field-picker';
  picker.innerHTML = `
    <div class="field-picker-head">حط النص في:</div>
    ${FIELD_PICKER.map(f => `<button type="button" data-key="${f.key}">${f.label}</button>`).join('')}
    <button type="button" class="cancel">إلغاء</button>
  `;
  document.body.appendChild(picker);
  const r = anchor.getBoundingClientRect();
  picker.style.top  = (window.scrollY + r.bottom + 4) + 'px';
  picker.style.left = (window.scrollX + r.left) + 'px';
  picker.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (btn) {
      const targetEl = els[btn.dataset.key];
      if (btn.dataset.key === 'fNid') {
        const digits = normalizeDigits(text).replace(/\D/g, '').slice(0, 14);
        targetEl.value = digits;
        onNidChange();
      } else if (btn.dataset.key === 'fPhone') {
        targetEl.value = normalizeDigits(text).replace(/\D/g, '');
      } else {
        targetEl.value = text;
      }
      targetEl.focus();
      picker.remove();
    } else if (e.target.classList.contains('cancel')) {
      picker.remove();
    }
  });
  setTimeout(() => {
    const closer = (ev) => {
      if (!picker.contains(ev.target)) { picker.remove(); document.removeEventListener('click', closer); }
    };
    document.addEventListener('click', closer);
  }, 0);
}

// ───────── NID live derive ─────────
function onNidChange() {
  const v = normalizeDigits(els.fNid.value).replace(/\D/g, '').slice(0, 14);
  els.fNid.value = v;
  const parsed = parseNationalId(v);
  if (!v) {
    els.nidHint.textContent = '';
    els.nidHint.className = 'field-hint';
    els.fGov.value = '';
    return;
  }
  if (!parsed) {
    els.nidHint.textContent = v.length < 14 ? `لسه ناقص ${14 - v.length} رقم` : 'الرقم القومي مش صحيح';
    els.nidHint.className = 'field-hint error';
    els.fGov.value = '';
    return;
  }
  els.nidHint.textContent = `✓ تاريخ ميلاد: ${parsed.dob} · ${parsed.gender} · ${parsed.gov}`;
  els.nidHint.className = 'field-hint ok';
  if (!els.fDob.value) els.fDob.value = parsed.dob;
  if (!els.fGender.value) els.fGender.value = parsed.gender;
  els.fGov.value = parsed.gov;
}
els.fNid.addEventListener('input', onNidChange);

// ───────── add / clear ─────────
function readForm() {
  return {
    nameAr:   els.fNameAr.value.trim(),
    nameEn:   els.fNameEn.value.trim(),
    nid:      els.fNid.value.trim(),
    dob:      els.fDob.value,
    expiry:   els.fExpiry.value,
    gender:   els.fGender.value,
    religion: els.fReligion.value,
    gov:      els.fGov.value.trim(),
    email:    els.fEmail.value.trim(),
    phone:    els.fPhone.value.trim(),
    address:  els.fAddress.value.trim(),
  };
}

function clearForm() {
  ['fNameAr','fNameEn','fNid','fDob','fExpiry','fReligion','fGender','fGov','fEmail','fPhone','fAddress']
    .forEach(k => els[k].value = '');
  els.nidHint.textContent = '';
  els.nidHint.className = 'field-hint';
}

function clearUploads() {
  ['front','back','cv'].forEach(kind => {
    files[kind] = null;
    rawText[kind] = '';
    const card = kind === 'front' ? els.upFront : kind === 'back' ? els.upBack : els.upCv;
    const prev = card.querySelector('.upload-preview');
    prev.querySelector('img').src = '';
    prev.classList.add('hidden');
    card.classList.remove('has-file');
  });
  els.fileFront.value = ''; els.fileBack.value = ''; els.fileCv.value = '';
  els.ocrRaw.classList.add('hidden');
  els.ocrStatus.textContent = '';
  els.ocrStatus.className = 'status';
  refreshExtractBtn();
}

els.btnClear.addEventListener('click', () => {
  clearForm();
  clearUploads();
  els.formStatus.textContent = '';
});

els.btnAdd.addEventListener('click', () => {
  const data = readForm();
  if (!data.nameAr) return setFormStatus('⚠ لازم تكتب الاسم بالعربي', 'error');
  if (!data.nid || data.nid.length !== 14) return setFormStatus('⚠ الرقم القومي لازم يكون 14 رقم', 'error');
  if (entries.some(e => e.nid === data.nid)) {
    if (!confirm(`الرقم القومي ${data.nid} موجود قبل كده في الشيت. تضيفه تاني؟`)) return;
  }
  entries.push(data);
  renderTable();
  clearForm();
  clearUploads();
  setFormStatus(`✓ اتضاف بنجاح (إجمالي: ${entries.length})`, 'success');
});

function setFormStatus(msg, type) {
  els.formStatus.textContent = msg;
  els.formStatus.className = 'status ' + (type || '');
  if (type === 'success') setTimeout(() => {
    if (els.formStatus.textContent === msg) {
      els.formStatus.textContent = '';
      els.formStatus.className = 'status';
    }
  }, 4000);
}

// ───────── table render ─────────
function renderTable() {
  els.rowCount.textContent = entries.length;
  els.btnExport.disabled = entries.length === 0;
  els.btnClearAll.disabled = entries.length === 0;
  els.emptyState.style.display = entries.length === 0 ? 'block' : 'none';

  const rows = entries.map((e, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(e.nameAr)}</td>
      <td class="cell-en">${escapeHtml(e.nameEn)}</td>
      <td class="cell-num">${escapeHtml(e.nid)}</td>
      <td class="cell-num">${escapeHtml(e.dob)}</td>
      <td class="cell-num">${escapeHtml(e.expiry)}</td>
      <td>${escapeHtml(e.gender)}</td>
      <td>${escapeHtml(e.religion)}</td>
      <td class="cell-en">${escapeHtml(e.email)}</td>
      <td class="cell-num">${escapeHtml(e.phone)}</td>
      <td>${escapeHtml(e.address)}</td>
      <td><button class="row-del" data-idx="${i}" title="حذف">×</button></td>
    </tr>
  `).join('');
  els.tableBody.innerHTML = rows;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
}

els.tableBody.addEventListener('click', (e) => {
  if (e.target.classList.contains('row-del')) {
    const idx = +e.target.dataset.idx;
    if (confirm(`حذف الموظف رقم ${idx + 1} (${entries[idx].nameAr})؟`)) {
      entries.splice(idx, 1);
      renderTable();
    }
  }
});

els.btnClearAll.addEventListener('click', () => {
  if (entries.length && confirm(`متأكد إنك عايز تمسح كل ${entries.length} موظف من الشيت؟`)) {
    entries = [];
    renderTable();
  }
});

// ───────── import / export ─────────
const COLS = [
  { key: 'nameAr',   header: 'الاسم بالعربي' },
  { key: 'nameEn',   header: 'English Name' },
  { key: 'nid',      header: 'الرقم القومي' },
  { key: 'dob',      header: 'تاريخ الميلاد' },
  { key: 'expiry',   header: 'تاريخ انتهاء البطاقة' },
  { key: 'gender',   header: 'النوع' },
  { key: 'religion', header: 'الديانة' },
  { key: 'gov',      header: 'المحافظة' },
  { key: 'email',    header: 'الإيميل' },
  { key: 'phone',    header: 'التليفون' },
  { key: 'address',  header: 'العنوان' },
];

// header synonyms for import
const HEADER_MAP = {
  'الاسم بالعربي': 'nameAr', 'الاسم العربي': 'nameAr', 'الاسم': 'nameAr', 'arabic name': 'nameAr', 'name (ar)': 'nameAr',
  'english name': 'nameEn', 'الاسم بالإنجليزي': 'nameEn', 'name': 'nameEn', 'name (en)': 'nameEn',
  'الرقم القومي': 'nid', 'national id': 'nid', 'nid': 'nid', 'id': 'nid',
  'تاريخ الميلاد': 'dob', 'date of birth': 'dob', 'dob': 'dob', 'birth date': 'dob',
  'تاريخ انتهاء البطاقة': 'expiry', 'الانتهاء': 'expiry', 'expiry': 'expiry', 'expiry date': 'expiry', 'id expiry': 'expiry',
  'النوع': 'gender', 'gender': 'gender', 'sex': 'gender',
  'الديانة': 'religion', 'religion': 'religion',
  'المحافظة': 'gov', 'governorate': 'gov',
  'الإيميل': 'email', 'البريد الإلكتروني': 'email', 'email': 'email', 'e-mail': 'email',
  'التليفون': 'phone', 'الموبايل': 'phone', 'phone': 'phone', 'mobile': 'phone',
  'العنوان': 'address', 'address': 'address',
};

els.btnExport.addEventListener('click', () => {
  const data = [COLS.map(c => c.header)];
  entries.forEach(e => data.push(COLS.map(c => e[c.key] ?? '')));
  const ws = XLSX.utils.aoa_to_sheet(data);
  // column widths
  ws['!cols'] = [
    {wch:28},{wch:28},{wch:18},{wch:13},{wch:13},{wch:8},{wch:10},{wch:14},{wch:28},{wch:14},{wch:36}
  ];
  ws['!rtl'] = true;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Hiring');
  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `hiring-sheet-${today}.xlsx`);
  setTableStatus(`✓ تم تنزيل الشيت (${entries.length} موظف)`, 'success');
});

els.fileImport.addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!rows.length) return setTableStatus('⚠ الشيت فاضي', 'error');

    // map headers
    const headerRow = rows[0].map(h => String(h || '').trim().toLowerCase());
    const colIndex = {};
    headerRow.forEach((h, i) => {
      const key = HEADER_MAP[h] || HEADER_MAP[h.replace(/\s+/g, ' ')];
      if (key) colIndex[key] = i;
    });

    let added = 0, skipped = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every(c => !String(c).trim())) continue;
      const entry = {};
      COLS.forEach(c => {
        const idx = colIndex[c.key];
        entry[c.key] = idx != null ? String(row[idx] ?? '').trim() : '';
      });
      // normalize NID
      entry.nid = normalizeDigits(entry.nid).replace(/\D/g, '').slice(0, 14);
      if (!entry.nameAr && !entry.nid && !entry.nameEn) { skipped++; continue; }
      // skip exact NID duplicates if NID present
      if (entry.nid && entries.some(e => e.nid === entry.nid)) { skipped++; continue; }
      // auto-fill missing dob/gender/gov from NID
      const parsed = entry.nid ? parseNationalId(entry.nid) : null;
      if (parsed) {
        if (!entry.dob) entry.dob = parsed.dob;
        if (!entry.gender) entry.gender = parsed.gender;
        if (!entry.gov) entry.gov = parsed.gov;
      }
      entries.push(entry);
      added++;
    }
    renderTable();
    setTableStatus(`✓ تم استيراد ${added} موظف${skipped ? ` (تجاهلنا ${skipped})` : ''}`, 'success');
  } catch (err) {
    console.error(err);
    setTableStatus('⚠ مش قادر يقرا الفايل: ' + (err.message || err), 'error');
  } finally {
    e.target.value = '';
  }
});

function setTableStatus(msg, type) {
  els.tableStatus.textContent = msg;
  els.tableStatus.className = 'status ' + (type || '');
  if (type === 'success') setTimeout(() => {
    if (els.tableStatus.textContent === msg) {
      els.tableStatus.textContent = '';
      els.tableStatus.className = 'status';
    }
  }, 5000);
}

// ───────── init ─────────
renderTable();
refreshExtractBtn();
