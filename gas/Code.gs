/**
 * =========================================================================
 * SISTEM PRESENSI DIGITAL PANITIA KIP 2026
 * Google Apps Script Backend (Code.gs)
 * =========================================================================
 * Terintegrasi dengan Google Sheets:
 * - PANITIA KIP : Master biodata 46 panitia (Read-only identitas)
 * - AGENDA      : Master agenda & sesi rapat (ID unik, status, info)
 * - raw_presensi: Transaksi log kehadiran (Anti-duplikasi NIM + Agenda ID)
 * - PRESENSI    : Rekap matriks kehadiran otomatis per kolom agenda
 * - ADMIN_LOG   : Riwayat aktivitas dan audit trail
 * =========================================================================
 */

// Konfigurasi Nama Sheet
const SHEET_PANITIA    = "PANITIA KIP";
const SHEET_AGENDA     = "AGENDA";
const SHEET_RAW        = "raw_presensi";
const SHEET_PRESENSI   = "PRESENSI";
const SHEET_ADMIN_LOG  = "ADMIN_LOG";

// PIN Default Admin (Dapat diubah lewat Script Properties 'ADMIN_PIN')
const DEFAULT_ADMIN_PIN = "KIP2026";

/**
 * Mendapatkan instance Spreadsheet aktif.
 * Mendukung container-bound script maupun standalone script melalui script property 'SPREADSHEET_ID'.
 */
function getSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  const customId = props.getProperty("SPREADSHEET_ID");
  if (customId) {
    return SpreadsheetApp.openById(customId);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Entry point HTTP GET (Web App GAS)
 */
function doGet(e) {
  // Setup inisialisasi sheet otomatis jika belum ada
  try {
    initSystem();
  } catch (err) {
    console.error("Auto init error: " + err.message);
  }

  // Jika memanggil API endpoint via GET
  if (e && e.parameter && e.parameter.action) {
    return handleApiGet(e.parameter);
  }

  // Render template (Web App Index atau Admin)
  const isPageAdmin = (e && e.parameter && e.parameter.page === "admin");
  const pageFile = isPageAdmin ? "Admin" : "Index";
  const template = HtmlService.createTemplateFromFile(pageFile);
  return template.evaluate()
    .setTitle(isPageAdmin ? "Dashboard Administrator - Presensi KIP 2026" : "Presensi Digital Panitia KIP 2026")
    .addMetaTag("viewport", "width=device-width, initial-scale=1.0")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Entry point HTTP POST (Untuk integrasi external API / Web App di subdomain / VPS)
 */
function doPost(e) {
  try {
    let postData = {};
    if (e && e.postData && e.postData.contents) {
      try {
        postData = JSON.parse(e.postData.contents);
      } catch (err) {
        postData = e.parameter || {};
      }
    } else if (e && e.parameter) {
      postData = e.parameter;
    }

    const action = postData.action;
    let result = { success: false, message: "Action tidak dikenali" };

    if (action === "submitPresensi") {
      result = submitPresensi(postData.payload || postData);
    } else if (action === "searchPanitia" || action === "searchNIM") {
      result = searchPanitiaByNIM(postData.nim);
    } else if (action === "getActiveAgenda") {
      result = getActiveAgenda();
    } else if (action === "getDashboard") {
      result = getDashboardStats(postData.pin);
    } else if (action === "adminLogin") {
      result = adminLogin(postData.pin);
    } else if (action === "createAgenda") {
      result = createAgenda(postData.payload || postData, postData.pin);
    } else if (action === "closeAgenda") {
      result = closeAgenda(postData.agendaId, postData.pin);
    }

    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: "Terjadi kesalahan server: " + error.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Include helper untuk modular HTML templates
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Handler GET API query parameters (Mendukung integrasi dari frontend subdomain)
 */
function handleApiGet(params) {
  let result = {};
  const action = params.action;

  if (action === "getActiveAgenda") {
    result = getActiveAgenda();
  } else if (action === "searchNIM" || action === "searchPanitia") {
    result = searchPanitiaByNIM(params.nim);
  } else if (action === "getDashboard") {
    result = getDashboardStats(params.pin);
  } else if (action === "adminLogin") {
    result = adminLogin(params.pin);
  } else if (action === "submitPresensi") {
    let payload = {};
    if (params.data) {
      try { payload = JSON.parse(decodeURIComponent(params.data)); } catch (e) { payload = params; }
    } else {
      payload = {
        nim: params.nim,
        agendaId: params.agendaId,
        sessionCode: params.sessionCode,
        deviceInfo: params.deviceInfo || "Web API"
      };
    }
    result = submitPresensi(payload);
  } else if (action === "createAgenda") {
    let payload = {};
    if (params.data) {
      try { payload = JSON.parse(decodeURIComponent(params.data)); } catch (e) { payload = params; }
    } else {
      payload = params;
    }
    result = createAgenda(payload, params.pin);
  } else if (action === "closeAgenda") {
    result = closeAgenda(params.agendaId, params.pin);
  } else {
    result = { success: false, message: "Action tidak valid" };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * =========================================================================
 * 1. INISIALISASI DATABASE & STRUKTUR SHEET
 * =========================================================================
 * Memastikan semua sheet pendukung tersedia tanpa merusak isi sheet PANITIA KIP.
 */
function initSystem() {
  const ss = getSpreadsheet();

  // 1. Sheet AGENDA
  let agendaSheet = ss.getSheetByName(SHEET_AGENDA);
  if (!agendaSheet) {
    agendaSheet = ss.insertSheet(SHEET_AGENDA);
    const headers = [
      ["ID Agenda", "Judul Agenda", "Tanggal", "Waktu", "Lokasi", "Kode Sesi", "Status", "Dibuat Pada", "Total Hadir"]
    ];
    agendaSheet.getRange(1, 1, 1, headers[0].length).setValues(headers)
      .setFontWeight("bold")
      .setBackground("#1e293b")
      .setFontColor("#ffffff");
    agendaSheet.setFrozenRows(1);
  }

  // 2. Sheet raw_presensi
  let rawSheet = ss.getSheetByName(SHEET_RAW);
  if (!rawSheet) {
    rawSheet = ss.insertSheet(SHEET_RAW);
    const headers = [
      ["Timestamp", "ID Agenda", "Judul Agenda", "NIM", "Nama", "Jabatan", "Sie", "Delegasi", "Status", "Waktu Presensi", "Device / Info"]
    ];
    rawSheet.getRange(1, 1, 1, headers[0].length).setValues(headers)
      .setFontWeight("bold")
      .setBackground("#0f766e")
      .setFontColor("#ffffff");
    rawSheet.setFrozenRows(1);
  } else if (rawSheet.getLastRow() === 0) {
    const headers = [
      ["Timestamp", "ID Agenda", "Judul Agenda", "NIM", "Nama", "Jabatan", "Sie", "Delegasi", "Status", "Waktu Presensi", "Device / Info"]
    ];
    rawSheet.getRange(1, 1, 1, headers[0].length).setValues(headers)
      .setFontWeight("bold")
      .setBackground("#0f766e")
      .setFontColor("#ffffff");
    rawSheet.setFrozenRows(1);
  }

  // 3. Sheet ADMIN_LOG
  let logSheet = ss.getSheetByName(SHEET_ADMIN_LOG);
  if (!logSheet) {
    logSheet = ss.insertSheet(SHEET_ADMIN_LOG);
    const headers = [["Timestamp", "Aktivitas", "Detail", "Pelaksana"]];
    logSheet.getRange(1, 1, 1, headers[0].length).setValues(headers)
      .setFontWeight("bold")
      .setBackground("#334155")
      .setFontColor("#ffffff");
    logSheet.setFrozenRows(1);
  }

  return { success: true, message: "Struktur database siap digunakan." };
}

/**
 * =========================================================================
 * 2. FITUR ANGGOTA: CARI BIODATA & SUBMIT PRESENSI
 * =========================================================================
 */

/**
 * Mencari data panitia dari sheet PANITIA KIP berdasarkan NIM.
 * Sanitasi nomor NIM (menghilangkan spasi, titik, strip, konversi string).
 */
function searchPanitiaByNIM(inputNim) {
  if (!inputNim) {
    return { success: false, message: "Silakan masukkan NIM Anda." };
  }

  const cleanNim = String(inputNim).trim().replace(/\D/g, "");
  if (cleanNim.length < 5) {
    return { success: false, message: "Format NIM tidak valid." };
  }

  const ss = getSpreadsheet();
  const panitiaSheet = ss.getSheetByName(SHEET_PANITIA);
  if (!panitiaSheet) {
    return { success: false, message: "Sheet '" + SHEET_PANITIA + "' tidak ditemukan di spreadsheet." };
  }

  const data = panitiaSheet.getDataRange().getValues();
  if (data.length <= 1) {
    return { success: false, message: "Data panitia masih kosong." };
  }

  // Baris 1: Header (No, Nama, NIM, Jabatan, Sie, No. HP, Delegasi)
  // Mapping index kolom (0-based)
  let colNama = 1;     // Kolom B
  let colNim = 2;      // Kolom C
  let colJabatan = 3;  // Kolom D
  let colSie = 4;      // Kolom E
  let colHp = 5;       // Kolom F
  let colDelegasi = 6; // Kolom G

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const rawRowNim = row[colNim];
    const rowNama = row[colNama];

    if (!rowNama || String(rowNama).trim() === "") {
      continue; // Lewati baris template kosong
    }

    // Normalisasi NIM di spreadsheet
    let rowNimStr = "";
    if (typeof rawRowNim === "number") {
      rowNimStr = Math.floor(rawRowNim).toString();
    } else {
      rowNimStr = String(rawRowNim).trim().replace(/\D/g, "");
    }

    if (rowNimStr === cleanNim) {
      // Normalisasi Nomor HP
      let hpStr = String(row[colHp] || "").trim();
      if (hpStr.startsWith("62")) {
        hpStr = "0" + hpStr.substring(2);
      }

      return {
        success: true,
        data: {
          no: row[0],
          nama: String(rowNama).trim(),
          nim: rowNimStr,
          jabatan: String(row[colJabatan] || "-").trim(),
          sie: String(row[colSie] || "-").trim(),
          noHp: hpStr,
          delegasi: String(row[colDelegasi] || "-").trim()
        }
      };
    }
  }

  return {
    success: false,
    message: "NIM (" + cleanNim + ") tidak ditemukan dalam master data Panitia KIP 2026. Hubungi panitia jika Anda anggota resmi."
  };
}

/**
 * Mengambil Agenda Rapat yang Sedang Aktif
 */
function getActiveAgenda() {
  const ss = getSpreadsheet();
  const agendaSheet = ss.getSheetByName(SHEET_AGENDA);
  if (!agendaSheet || agendaSheet.getLastRow() <= 1) {
    return { success: false, message: "Belum ada agenda rapat yang dibuat." };
  }

  const data = agendaSheet.getDataRange().getValues();
  // Header: ID Agenda, Judul, Tanggal, Waktu, Lokasi, Kode Sesi, Status, Dibuat Pada, Total Hadir
  for (let i = data.length - 1; i >= 1; i--) {
    const row = data[i];
    const status = String(row[6]).trim().toUpperCase();

    if (status === "AKTIF") {
      let tglStr = row[2];
      if (tglStr instanceof Date) {
        tglStr = Utilities.formatDate(tglStr, "Asia/Jakarta", "dd MMMM yyyy");
      }

      let waktuStr = row[3];
      if (waktuStr instanceof Date) {
        waktuStr = Utilities.formatDate(waktuStr, "Asia/Jakarta", "HH:mm") + " WIB";
      }

      return {
        success: true,
        agenda: {
          id: String(row[0]),
          title: String(row[1]),
          date: String(tglStr),
          time: String(waktuStr),
          location: String(row[4] || "Ruang Rapat Panitia"),
          hasSessionCode: (String(row[5] || "").trim() !== ""),
          status: "AKTIF",
          createdAt: row[7],
          totalHadir: row[8] || 0
        }
      };
    }
  }

  return { success: false, message: "Tidak ada agenda rapat yang sedang aktif saat ini." };
}

/**
 * Helper terstandarisasi untuk memformat waktu presensi menjadi "HH:mm:ss".
 * Mengatasi issue Google Sheets yang mengonversi cell waktu menjadi objek Date 30 Desember 1899.
 * Mengonversi objek Date menggunakan zona waktu Asia/Jakarta.
 * Menangani objek Date, string waktu, string ISO, maupun string bertuliskan 'HADIR (Sat Dec 30 1899...)'.
 */
function formatPresensiTime(val) {
  if (!val && val !== 0) return "";

  // 1. Objek Date asli (Date object dari Google Sheets atau JavaScript)
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return "";
    try {
      return Utilities.formatDate(val, "Asia/Jakarta", "HH:mm:ss");
    } catch (err) {
      const pad = function(n) { return (n < 10 ? "0" : "") + n; };
      return pad(val.getHours()) + ":" + pad(val.getMinutes()) + ":" + pad(val.getSeconds());
    }
  }

  const str = String(val).trim();
  if (!str) return "";

  // 2. Format murni HH:mm:ss atau HH:mm
  const pureMatch = str.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (pureMatch) {
    const hh = pureMatch[1].padStart(2, "0");
    const mm = pureMatch[2];
    const ss = pureMatch[3] ? pureMatch[3] : "00";
    return hh + ":" + mm + ":" + ss;
  }

  // 3. String mengandung substring waktu HH:mm:ss (misal: "HADIR (Sat Dec 30 1899 18:07:32 GMT+0707...)" atau "18:07:32 WIB")
  const embeddedMatch = str.match(/\b([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)\b/);
  if (embeddedMatch) {
    const hh = embeddedMatch[1].padStart(2, "0");
    const mm = embeddedMatch[2];
    const ss = embeddedMatch[3];
    return hh + ":" + mm + ":" + ss;
  }

  // 4. Jika memuat teks 1899 atau format tanggal ISO/RFC yang dapat diparsing
  if (str.includes("1899") || str.includes("T") || str.includes("GMT")) {
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      try {
        return Utilities.formatDate(parsed, "Asia/Jakarta", "HH:mm:ss");
      } catch (err) {
        const pad = function(n) { return (n < 10 ? "0" : "") + n; };
        return pad(parsed.getHours()) + ":" + pad(parsed.getMinutes()) + ":" + pad(parsed.getSeconds());
      }
    }
  }

  return str;
}

/**
 * Menyimpan Presensi Anggota ke raw_presensi dan sync ke PRESENSI
 * Dilengkapi Anti-Duplikasi (NIM + ID Agenda) & Concurrency Lock
 */
function submitPresensi(payload) {
  if (!payload || !payload.nim || !payload.agendaId) {
    return { success: false, message: "Data presensi tidak lengkap." };
  }

  // Menggunakan LockService untuk mencegah race-condition
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000); // Tunggu hingga 10 detik
  } catch (e) {
    return { success: false, message: "Server sedang sibuk, silakan coba beberapa detik lagi." };
  }

  try {
    const ss = getSpreadsheet();

    // 1. Verifikasi Status Agenda
    const agendaRes = getActiveAgenda();
    if (!agendaRes.success || !agendaRes.agenda) {
      return { success: false, message: "Presensi gagal: Tidak ada agenda rapat yang aktif." };
    }

    const activeAgenda = agendaRes.agenda;
    if (activeAgenda.id !== payload.agendaId) {
      return { success: false, message: "Presensi gagal: Agenda ini telah ditutup atau digantikan agenda lain." };
    }

    // 2. Verifikasi Kode Sesi (jika agenda memerlukan kode)
    const agendaSheet = ss.getSheetByName(SHEET_AGENDA);
    const agendaData = agendaSheet.getDataRange().getValues();
    let verifiedSessionCode = "";
    let agendaRowIdx = -1;

    for (let i = 1; i < agendaData.length; i++) {
      if (String(agendaData[i][0]) === payload.agendaId) {
        verifiedSessionCode = String(agendaData[i][5] || "").trim();
        agendaRowIdx = i + 1;
        break;
      }
    }

    if (verifiedSessionCode !== "") {
      const inputCode = String(payload.sessionCode || "").trim();
      if (inputCode.toUpperCase() !== verifiedSessionCode.toUpperCase()) {
        return { success: false, message: "Kode sesi rapat salah! Minta kode verifikasi kepada sekretaris di ruangan." };
      }
    }

    // 3. Verifikasi Identitas Panitia dari Sheet PANITIA KIP (Server-Side)
    const panitiaRes = searchPanitiaByNIM(payload.nim);
    if (!panitiaRes.success) {
      return { success: false, message: panitiaRes.message };
    }
    const panitia = panitiaRes.data;

    // 4. Anti-Duplikasi: Cek apakah NIM + Agenda ID sudah tercatat di raw_presensi
    const rawSheet = ss.getSheetByName(SHEET_RAW);
    const rawData = rawSheet.getDataRange().getValues();
    const cleanNim = panitia.nim;

    for (let i = 1; i < rawData.length; i++) {
      const row = rawData[i];
      const rowAgendaId = String(row[1]);
      let rowNim = "";
      if (typeof row[3] === "number") {
        rowNim = Math.floor(row[3]).toString();
      } else {
        rowNim = String(row[3]).trim().replace(/\D/g, "");
      }

      if (rowAgendaId === payload.agendaId && rowNim === cleanNim) {
        let existingWaktu = formatPresensiTime(row[9]) || "sebelumnya";
        return {
          success: false,
          duplicate: true,
          message: "Anda (" + panitia.nama + ") SUDAH melakukan presensi untuk agenda '" + activeAgenda.title + "' pada pukul " + existingWaktu + " WIB."
        };
      }
    }

    // 5. Catat Transaksi ke raw_presensi
    const now = new Date();
    const waktuFormatted = Utilities.formatDate(now, "Asia/Jakarta", "HH:mm:ss");
    const tglFullFormatted = Utilities.formatDate(now, "Asia/Jakarta", "dd MMMM yyyy, HH:mm:ss") + " WIB";

    rawSheet.appendRow([
      now,
      activeAgenda.id,
      activeAgenda.title,
      cleanNim,
      panitia.nama,
      panitia.jabatan,
      panitia.sie,
      panitia.delegasi,
      "HADIR",
      waktuFormatted,
      payload.deviceInfo || "Web Browser"
    ]);

    // Format sel waktu presensi (Kolom 10) sebagai teks murni agar terhindar dari konversi otomatis Date 1899
    const lastRawRow = rawSheet.getLastRow();
    if (lastRawRow > 1) {
      rawSheet.getRange(lastRawRow, 10).setNumberFormat("@");
    }

    // 6. Update Jumlah Total Hadir di Sheet AGENDA
    if (agendaRowIdx > 0) {
      const curTotal = Number(agendaSheet.getRange(agendaRowIdx, 9).getValue()) || 0;
      agendaSheet.getRange(agendaRowIdx, 9).setValue(curTotal + 1);
    }

    // 7. Sinkronisasi Otomatis ke Matriks Sheet PRESENSI
    syncPresensiMatrix(ss, activeAgenda, cleanNim, waktuFormatted);

    // 8. Tulis Riwayat ke ADMIN_LOG
    writeAdminLog("PRESENSI_ANGGOTA", panitia.nama + " (" + cleanNim + ") hadir pada " + activeAgenda.title, "SISTEM");

    return {
      success: true,
      message: "Kehadiran Anda berhasil diverifikasi dan dicatat!",
      data: {
        nama: panitia.nama,
        nim: panitia.nim,
        jabatan: panitia.jabatan,
        sie: panitia.sie,
        delegasi: panitia.delegasi,
        agendaTitle: activeAgenda.title,
        agendaId: activeAgenda.id,
        waktuPresensi: waktuFormatted
      }
    };

  } finally {
    lock.releaseLock();
  }
}

/**
 * Sinkronisasi kehadiran individu ke dalam matriks sheet PRESENSI
 */
function syncPresensiMatrix(ss, agenda, nim, waktu) {
  try {
    const presensiSheet = ss.getSheetByName(SHEET_PRESENSI);
    if (!presensiSheet) return;

    const data = presensiSheet.getDataRange().getValues();
    if (data.length <= 2) return;

    // Pastikan format waktu selalu bersih "HH:mm:ss"
    const cleanTime = formatPresensiTime(waktu);
    const cellValue = cleanTime ? ("HADIR (" + cleanTime + ")") : "HADIR";

    // Cari kolom untuk agenda ini di Row 1 & 2
    let targetCol = -1;
    for (let c = 7; c < data[0].length; c++) {
      const colTitle = String(data[1][c] || "").trim();
      if (colTitle === agenda.title) {
        targetCol = c + 1; // 1-based index
        break;
      }
    }

    // Jika kolom belum ada, buat kolom baru
    if (targetCol === -1) {
      targetCol = presensiSheet.getLastColumn() + 1;
      presensiSheet.getRange(1, targetCol).setValue(agenda.date).setFontWeight("bold").setHorizontalAlignment("center");
      presensiSheet.getRange(2, targetCol).setValue(agenda.title).setFontWeight("bold").setHorizontalAlignment("center");
    }

    // Cari baris anggota berdasarkan NIM di Kolom C (index 2)
    for (let r = 2; r < data.length; r++) {
      let rowNim = "";
      if (typeof data[r][2] === "number") {
        rowNim = Math.floor(data[r][2]).toString();
      } else {
        rowNim = String(data[r][2]).trim().replace(/\D/g, "");
      }

      if (rowNim === nim) {
        const targetCell = presensiSheet.getRange(r + 1, targetCol);
        targetCell.setNumberFormat("@"); // Set format teks agar Google Sheets tidak mengubahnya
        targetCell
          .setValue(cellValue)
          .setFontColor("#15803d")
          .setFontWeight("bold")
          .setHorizontalAlignment("center");
        break;
      }
    }
  } catch (err) {
    console.error("Sync PRESENSI error: " + err.message);
  }
}

/**
 * =========================================================================
 * 3. FITUR ADMIN: LOGIN, MANAJEMEN AGENDA & MONITORING
 * =========================================================================
 */

/**
 * Verifikasi Login Admin
 */
function verifyAdminPin(pin) {
  const props = PropertiesService.getScriptProperties();
  const validPin = props.getProperty("ADMIN_PIN") || DEFAULT_ADMIN_PIN;
  return (String(pin).trim() === validPin);
}

/**
 * Endpoint login admin
 */
function adminLogin(pin) {
  if (verifyAdminPin(pin)) {
    writeAdminLog("LOGIN_ADMIN", "Admin berhasil login", "ADMIN");
    return { success: true, token: "ADMIN_AUTH_TOKEN" };
  }
  return { success: false, message: "PIN Admin tidak valid!" };
}

/**
 * Ganti PIN Admin
 */
function changeAdminPin(oldPin, newPin) {
  if (!verifyAdminPin(oldPin)) {
    return { success: false, message: "PIN lama tidak sesuai!" };
  }
  if (!newPin || String(newPin).trim().length < 4) {
    return { success: false, message: "PIN baru minimal 4 karakter." };
  }
  PropertiesService.getScriptProperties().setProperty("ADMIN_PIN", String(newPin).trim());
  writeAdminLog("UBAH_PIN", "PIN admin berhasil diperbarui", "ADMIN");
  return { success: true, message: "PIN Admin berhasil diperbarui!" };
}

/**
 * Membuat Agenda Rapat Baru (Generate Agenda)
 * ID Unik: KIP-YYYYMMDD-XXX
 */
function createAgenda(payload, pin) {
  if (!verifyAdminPin(pin)) {
    return { success: false, message: "Autentikasi admin gagal." };
  }
  if (!payload || !payload.title) {
    return { success: false, message: "Judul agenda wajib diisi." };
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { success: false, message: "Sistem sibuk, silakan ulangi kembali." };
  }

  try {
    const ss = getSpreadsheet();
    initSystem();
    const agendaSheet = ss.getSheetByName(SHEET_AGENDA);

    // 1. Tutup semua agenda aktif sebelumnya
    const agendaData = agendaSheet.getDataRange().getValues();
    for (let i = 1; i < agendaData.length; i++) {
      if (String(agendaData[i][6]).trim().toUpperCase() === "AKTIF") {
        agendaSheet.getRange(i + 1, 7).setValue("SELESAI");
      }
    }

    // 2. Generate ID Unik: KIP-YYYYMMDD-001
    const today = new Date();
    const ymd = Utilities.formatDate(today, "Asia/Jakarta", "yyyyMMdd");
    let countToday = 1;

    for (let i = 1; i < agendaData.length; i++) {
      const idStr = String(agendaData[i][0]);
      if (idStr.indexOf("KIP-" + ymd) === 0) {
        countToday++;
      }
    }

    const seqStr = ("000" + countToday).slice(-3);
    const agendaId = "KIP-" + ymd + "-" + seqStr;

    const tgl = payload.date || Utilities.formatDate(today, "Asia/Jakarta", "dd MMMM yyyy");
    const waktu = payload.time || Utilities.formatDate(today, "Asia/Jakarta", "HH:mm") + " WIB";
    const lokasi = payload.location || "Ruang Rapat Utama / Gedung PKM";
    const sessionCode = payload.sessionCode ? String(payload.sessionCode).trim().toUpperCase() : "";

    agendaSheet.appendRow([
      agendaId,
      payload.title.trim(),
      tgl,
      waktu,
      lokasi,
      sessionCode,
      "AKTIF",
      new Date(),
      0
    ]);

    // 3. Tambahkan kolom agenda ke sheet PRESENSI jika belum ada
    setupAgendaInPresensiSheet(ss, agendaId, payload.title.trim(), tgl);

    writeAdminLog("GENERATE_AGENDA", "Membuat agenda: " + payload.title + " (ID: " + agendaId + ")", "ADMIN");

    return {
      success: true,
      message: "Agenda rapat berhasil diaktifkan!",
      agenda: {
        id: agendaId,
        title: payload.title.trim(),
        date: tgl,
        time: waktu,
        location: lokasi,
        sessionCode: sessionCode,
        status: "AKTIF"
      }
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Menyiapkan kolom baru pada sheet PRESENSI saat agenda baru dibuat
 */
function setupAgendaInPresensiSheet(ss, agendaId, title, date) {
  const presensiSheet = ss.getSheetByName(SHEET_PRESENSI);
  if (!presensiSheet) return;

  const lastCol = presensiSheet.getLastColumn();
  const nextCol = lastCol + 1;

  presensiSheet.getRange(1, nextCol)
    .setValue(date)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBackground("#f1f5f9");

  presensiSheet.getRange(2, nextCol)
    .setValue(title)
    .setFontWeight("bold")
    .setHorizontalAlignment("center")
    .setBackground("#e2e8f0");
}

/**
 * Mengakhiri / Menutup Agenda Aktif
 */
function closeAgenda(agendaId, pin) {
  if (!verifyAdminPin(pin)) {
    return { success: false, message: "Autentikasi admin gagal." };
  }

  const ss = getSpreadsheet();
  const agendaSheet = ss.getSheetByName(SHEET_AGENDA);
  if (!agendaSheet) return { success: false, message: "Sheet AGENDA tidak ditemukan." };

  const data = agendaSheet.getDataRange().getValues();
  let found = false;
  let title = "";

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === agendaId) {
      agendaSheet.getRange(i + 1, 7).setValue("SELESAI");
      title = data[i][1];
      found = true;
      break;
    }
  }

  if (found) {
    writeAdminLog("TUTUP_AGENDA", "Menutup agenda: " + title + " (" + agendaId + ")", "ADMIN");
    // Jalankan final rekap sinkronisasi ke sheet PRESENSI
    runFullRecapForAgenda(agendaId);
    return { success: true, message: "Agenda '" + title + "' berhasil ditutup." };
  }

  return { success: false, message: "ID Agenda tidak ditemukan." };
}

/**
 * Sinkronisasi Rekap Keseluruhan untuk Agenda Tertentu ke Sheet PRESENSI
 */
function runFullRecapForAgenda(agendaId) {
  const ss = getSpreadsheet();
  const rawSheet = ss.getSheetByName(SHEET_RAW);
  const presensiSheet = ss.getSheetByName(SHEET_PRESENSI);
  if (!rawSheet || !presensiSheet) return;

  const rawData = rawSheet.getDataRange().getValues();
  const presensiData = presensiSheet.getDataRange().getValues();
  if (presensiData.length <= 2) return;

  // Kumpulkan list NIM yang hadir pada agenda ini beserta jamnya yang sudah terformat HH:mm:ss
  const attendeeMap = {};
  let agendaTitle = "";

  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    if (String(row[1]) === agendaId) {
      agendaTitle = row[2];
      let nimStr = "";
      if (typeof row[3] === "number") {
        nimStr = Math.floor(row[3]).toString();
      } else {
        nimStr = String(row[3]).trim().replace(/\D/g, "");
      }
      
      const cleanWaktu = formatPresensiTime(row[9]);
      attendeeMap[nimStr] = cleanWaktu;
    }
  }

  // Cari kolom di sheet PRESENSI
  let targetCol = -1;
  for (let c = 7; c < presensiData[0].length; c++) {
    if (String(presensiData[1][c]).trim() === String(agendaTitle).trim()) {
      targetCol = c + 1;
      break;
    }
  }

  if (targetCol === -1) {
    targetCol = presensiSheet.getLastColumn() + 1;
    presensiSheet.getRange(1, targetCol).setValue(Utilities.formatDate(new Date(), "Asia/Jakarta", "dd/MM/yyyy"));
    presensiSheet.getRange(2, targetCol).setValue(agendaTitle);
  }

  // Set format kolom target sebagai teks murni (@) agar Google Sheets tidak mengubah string waktu menjadi Date
  try {
    presensiSheet.getRange(3, targetCol, presensiData.length - 2, 1).setNumberFormat("@");
  } catch (fmtErr) {}

  // Tuliskan ke setiap baris anggota
  for (let r = 2; r < presensiData.length; r++) {
    let rowNim = "";
    if (typeof presensiData[r][2] === "number") {
      rowNim = Math.floor(presensiData[r][2]).toString();
    } else {
      rowNim = String(presensiData[r][2]).trim().replace(/\D/g, "");
    }

    if (rowNim && attendeeMap[rowNim] !== undefined) {
      const cleanTime = attendeeMap[rowNim];
      const cellText = cleanTime ? ("HADIR (" + cleanTime + ")") : "HADIR";
      presensiSheet.getRange(r + 1, targetCol)
        .setNumberFormat("@")
        .setValue(cellText)
        .setFontColor("#15803d")
        .setFontWeight("bold")
        .setHorizontalAlignment("center");
    } else if (rowNim) {
      const curCell = presensiSheet.getRange(r + 1, targetCol);
      const curVal = curCell.getValue();
      const curStr = String(curVal || "").trim();

      // Perbaiki data lama jika memuat format 1899 yang salah
      if (curStr.includes("HADIR") && (curStr.includes("1899") || curStr.includes("GMT"))) {
        const extractedTime = formatPresensiTime(curStr);
        const fixedText = extractedTime ? ("HADIR (" + extractedTime + ")") : "HADIR";
        curCell
          .setNumberFormat("@")
          .setValue(fixedText)
          .setFontColor("#15803d")
          .setFontWeight("bold")
          .setHorizontalAlignment("center");
      } else if (!curVal || curVal === "") {
        curCell
          .setValue("TIDAK HADIR")
          .setFontColor("#94a3b8")
          .setHorizontalAlignment("center");
      }
    }
  }
}

/**
 * Mengambil Seluruh Data Dashboard Admin (Real-time monitoring)
 */
function getDashboardStats(pin) {
  if (!verifyAdminPin(pin)) {
    return { success: false, message: "Akses ditolak. PIN Admin tidak valid." };
  }

  const ss = getSpreadsheet();
  initSystem();

  // 1. Ambil master seluruh panitia dari PANITIA KIP
  const panitiaSheet = ss.getSheetByName(SHEET_PANITIA);
  const allPanitia = [];
  const sieSet = new Set();

  if (panitiaSheet && panitiaSheet.getLastRow() > 1) {
    const pData = panitiaSheet.getDataRange().getValues();
    for (let i = 1; i < pData.length; i++) {
      const row = pData[i];
      const nama = String(row[1] || "").trim();
      if (!nama) continue; // Jangan masukkan template slot kosong

      let nimStr = "";
      if (typeof row[2] === "number") {
        nimStr = Math.floor(row[2]).toString();
      } else {
        nimStr = String(row[2]).trim().replace(/\D/g, "");
      }

      const sie = String(row[4] || "-").trim();
      if (sie && sie !== "-") sieSet.add(sie);

      allPanitia.push({
        no: row[0],
        nama: nama,
        nim: nimStr,
        jabatan: String(row[3] || "-").trim(),
        sie: sie,
        noHp: String(row[5] || "-").trim(),
        delegasi: String(row[6] || "-").trim(),
        status: "BELUM HADIR",
        waktuPresensi: "-"
      });
    }
  }

  // 2. Ambil active agenda (termasuk kode sesi rapat untuk Admin)
  const activeRes = getActiveAgenda();
  let activeAgenda = activeRes.success ? activeRes.agenda : null;
  if (activeAgenda) {
    const aSheet = ss.getSheetByName(SHEET_AGENDA);
    if (aSheet && aSheet.getLastRow() > 1) {
      const aData = aSheet.getDataRange().getValues();
      for (let i = 1; i < aData.length; i++) {
        if (String(aData[i][0]) === activeAgenda.id) {
          activeAgenda.sessionCode = String(aData[i][5] || "").trim();
          break;
        }
      }
    }
  }

  // 3. Ambil data kehadiran dari raw_presensi untuk agenda aktif
  const rawSheet = ss.getSheetByName(SHEET_RAW);
  let totalHadirCount = 0;
  const hadirMap = {};

  if (activeAgenda && rawSheet && rawSheet.getLastRow() > 1) {
    const rawData = rawSheet.getDataRange().getValues();
    for (let i = 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (String(row[1]) === activeAgenda.id) {
        let nim = "";
        if (typeof row[3] === "number") {
          nim = Math.floor(row[3]).toString();
        } else {
          nim = String(row[3]).trim().replace(/\D/g, "");
        }
        const cleanWaktu = formatPresensiTime(row[9]);
        hadirMap[nim] = {
          waktu: cleanWaktu || "-",
          device: row[10] || "-"
        };
      }
    }
  }

  // Update status kehadiran pada daftar panitia
  for (let i = 0; i < allPanitia.length; i++) {
    const p = allPanitia[i];
    if (hadirMap[p.nim]) {
      p.status = "HADIR";
      p.waktuPresensi = hadirMap[p.nim].waktu;
      totalHadirCount++;
    }
  }

  const totalPanitia = allPanitia.length;
  const belumHadirCount = Math.max(0, totalPanitia - totalHadirCount);
  const persentase = totalPanitia > 0 ? ((totalHadirCount / totalPanitia) * 100).toFixed(1) : "0.0";

  // 4. Ambil 10 aktivitas terakhir dari ADMIN_LOG
  const logSheet = ss.getSheetByName(SHEET_ADMIN_LOG);
  const recentLogs = [];
  if (logSheet && logSheet.getLastRow() > 1) {
    const logData = logSheet.getDataRange().getValues();
    const startIdx = Math.max(1, logData.length - 10);
    for (let i = logData.length - 1; i >= startIdx; i--) {
      const r = logData[i];
      let timeStr = r[0];
      if (timeStr instanceof Date) {
        timeStr = Utilities.formatDate(timeStr, "Asia/Jakarta", "dd/MM HH:mm");
      }
      recentLogs.push({
        time: timeStr,
        activity: r[1],
        detail: r[2],
        actor: r[3]
      });
    }
  }

  // 5. Ambil riwayat agenda sebelumnya
  const agendaSheet = ss.getSheetByName(SHEET_AGENDA);
  const agendaList = [];
  if (agendaSheet && agendaSheet.getLastRow() > 1) {
    const aData = agendaSheet.getDataRange().getValues();
    for (let i = aData.length - 1; i >= 1; i--) {
      const r = aData[i];
      let tglStr = r[2];
      if (tglStr instanceof Date) {
        tglStr = Utilities.formatDate(tglStr, "Asia/Jakarta", "dd/MM/yyyy");
      }
      agendaList.push({
        id: String(r[0]),
        title: String(r[1]),
        date: String(tglStr),
        time: String(r[3]),
        location: String(r[4]),
        sessionCode: String(r[5] || ""),
        status: String(r[6]),
        totalHadir: r[8] || 0
      });
    }
  }

  return {
    success: true,
    activeAgenda: activeAgenda,
    stats: {
      totalPanitia: totalPanitia,
      sudahHadir: totalHadirCount,
      belumHadir: belumHadirCount,
      persentase: persentase
    },
    panitia: allPanitia,
    sieList: Array.from(sieSet),
    recentLogs: recentLogs,
    agendas: agendaList
  };
}

/**
 * Mencatat log aktivitas admin / sistem
 */
function writeAdminLog(aktivitas, detail, pelaksana) {
  try {
    const ss = getSpreadsheet();
    const logSheet = ss.getSheetByName(SHEET_ADMIN_LOG);
    if (logSheet) {
      logSheet.appendRow([new Date(), aktivitas, detail, pelaksana || "SYSTEM"]);
    }
  } catch (e) {
    console.error("Log error: " + e.message);
  }
}

/**
 * =========================================================================
 * 4. MENU KUSTOM DI TOOLBAR GOOGLE SHEETS
 * =========================================================================
 * Mempermudah admin/panitia mengelola presensi langsung dari dalam spreadsheet.
 */
function onOpen() {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.createMenu("🎯 Panitia KIP 2026")
      .addItem("📋 Cek Status Agenda Aktif", "menuCheckActiveAgenda")
      .addItem("🔄 Sinkronisasi Ulang Rekap PRESENSI", "menuManualSync")
      .addSeparator()
      .addItem("⚙️ Inisialisasi / Buat Sheet Pendukung", "menuInitSystem")
      .addItem("🔑 Ubah PIN Admin", "menuChangePin")
      .addToUi();
  } catch (e) {
    // Abaikan jika dipanggil dari context standalone web app
  }
}

function menuCheckActiveAgenda() {
  const ui = SpreadsheetApp.getUi();
  const res = getActiveAgenda();
  if (res.success && res.agenda) {
    ui.alert(
      "Agenda Rapat Aktif",
      "Judul: " + res.agenda.title + "\n" +
      "ID: " + res.agenda.id + "\n" +
      "Tanggal: " + res.agenda.date + "\n" +
      "Waktu: " + res.agenda.time + "\n" +
      "Lokasi: " + res.agenda.location + "\n" +
      "Total Hadir: " + res.agenda.totalHadir + " orang\n\n" +
      "Presensi anggota sedang DIBUKA.",
      ui.ButtonSet.OK
    );
  } else {
    ui.alert("Status Agenda", "Saat ini TIDAK ADA agenda rapat yang aktif. Silakan buka Web App untuk generate agenda baru.", ui.ButtonSet.OK);
  }
}

/**
 * Memindai sheet PRESENSI dan membersihkan string waktu kehadiran yang memuat format '1899'
 * Mengonversi seluruh nilai menjadi format standar 'HADIR (HH:mm:ss)' tanpa merusak data lama.
 */
function repairExistingPresensiTimes(ss) {
  try {
    const presensiSheet = ss.getSheetByName(SHEET_PRESENSI);
    if (!presensiSheet || presensiSheet.getLastRow() <= 2 || presensiSheet.getLastColumn() < 8) return;

    const lastRow = presensiSheet.getLastRow();
    const lastCol = presensiSheet.getLastColumn();
    const range = presensiSheet.getRange(3, 8, lastRow - 2, lastCol - 7);
    const values = range.getValues();
    let modified = false;

    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        const val = values[r][c];
        if (val instanceof Date) {
          const formatted = formatPresensiTime(val);
          values[r][c] = formatted ? ("HADIR (" + formatted + ")") : "HADIR";
          modified = true;
        } else if (typeof val === "string" && (val.includes("1899") || val.includes("GMT"))) {
          const formatted = formatPresensiTime(val);
          values[r][c] = formatted ? ("HADIR (" + formatted + ")") : val;
          modified = true;
        }
      }
    }

    if (modified) {
      range.setNumberFormat("@");
      range.setValues(values);
    }
  } catch (err) {
    console.error("repairExistingPresensiTimes error: " + err.message);
  }
}

function menuManualSync() {
  const ui = SpreadsheetApp.getUi();
  const ss = getSpreadsheet();

  // 1. Bersihkan sel presensi yang terdampak format 1899
  repairExistingPresensiTimes(ss);

  // 2. Jalankan sinkronisasi untuk agenda aktif atau seluruh agenda di sheet AGENDA
  const res = getActiveAgenda();
  if (res.success && res.agenda) {
    runFullRecapForAgenda(res.agenda.id);
    ui.alert("Sukses", "Sinkronisasi ke sheet PRESENSI berhasil untuk agenda: " + res.agenda.title + "\nSeluruh waktu kehadiran telah diformat ke format standar HH:mm:ss.", ui.ButtonSet.OK);
  } else {
    const agendaSheet = ss.getSheetByName(SHEET_AGENDA);
    if (agendaSheet && agendaSheet.getLastRow() > 1) {
      const aData = agendaSheet.getDataRange().getValues();
      for (let i = 1; i < aData.length; i++) {
        const agId = String(aData[i][0] || "").trim();
        if (agId) runFullRecapForAgenda(agId);
      }
      ui.alert("Sukses", "Sinkronisasi rekap selesai untuk seluruh riwayat agenda. Seluruh waktu telah diformat rapi (HH:mm:ss).", ui.ButtonSet.OK);
    } else {
      ui.alert("Perhatian", "Belum ada agenda yang tersimpan di sheet AGENDA.", ui.ButtonSet.OK);
    }
  }
}

function menuInitSystem() {
  const ui = SpreadsheetApp.getUi();
  const res = initSystem();
  ui.alert("Inisialisasi Database", res.message, ui.ButtonSet.OK);
}

function menuChangePin() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt("Ubah PIN Admin", "Masukkan PIN baru (minimal 4 karakter):", ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() === ui.Button.OK) {
    const newPin = response.getResponseText().trim();
    if (newPin.length >= 4) {
      PropertiesService.getScriptProperties().setProperty("ADMIN_PIN", newPin);
      writeAdminLog("UBAH_PIN", "PIN admin diperbarui lewat menu spreadsheet", "ADMIN");
      ui.alert("Sukses", "PIN Admin berhasil diubah!", ui.ButtonSet.OK);
    } else {
      ui.alert("Gagal", "PIN harus memiliki minimal 4 karakter.", ui.ButtonSet.OK);
    }
  }
}

