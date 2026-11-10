# Sistem Presensi Digital Panitia KIP 2026

Aplikasi presensi digital terpadu berbasis **Google Apps Script (GAS)**, **Google Sheets**, dan antarmuka web modern (**HTML5, Tailwind CSS, JavaScript**) yang dirancang khusus untuk seluruh kegiatan rapat, koordinasi, dan evaluasi **Panitia KIP 2026 Politeknik Negeri Lhokseumawe**.

---

## 📁 Struktur Direktori Proyek

```
c:\laragon\www\presensi_kip26\
│
├── ANGGOTA KIP 2026 (1).xlsx   # File master spreadsheet panitia
├── index.html                  # Aplikasi web siap pakai (Local Simulation & Web App)
├── style.css                   # Custom styling, scrollbar, dan animasi glow
├── app.js                      # Controller client, anti-duplikasi & simulasi
├── data_panitia.js             # Data master 46 panitia hasil ekstraksi dari file Excel
├── panitia_extracted.json      # Backup JSON data 46 panitia
│
└── gas/                        # SOURCE CODE SIAP DEPLOY KE GOOGLE APPS SCRIPT
    ├── Code.gs                 # Backend GAS: Handler spreadsheet, anti-duplikasi, API
    ├── Index.html              # Template UI utama Web App
    ├── Style.html              # CSS Tailwind & glassmorphism modular
    ├── JavaScript.html         # Client logic google.script.run
    └── appsscript.json         # Manifest konfigurasi runtime V8 & zona waktu Jakarta
```

---

## ⚙️ Fitur Utama & Keunggulan Sistem

1. **Alur Presensi Cepat Berbasis NIM:**
   - Anggota hanya perlu memasukkan NIM (contoh: `2024203020008`).
   - Sistem secara otomatis mencocokkan NIM ke sheet `PANITIA KIP` (Server-Side).
   - Menampilkan biodata lengkap: Nama, Jabatan, Sie, No. HP, dan Delegasi Ormawa.
   - Anggota menekan tombol **"KONFIRMASI HADIR"** dan langsung menerima tiket/bukti presensi digital.

2. **Anti-Duplikasi Berlapis (NIM + ID Agenda):**
   - Satu panitia hanya dapat melakukan presensi **1 kali per sesi agenda rapat**.
   - Presensi kedua pada rapat yang sama akan langsung ditolak sistem dengan notifikasi waktu presensi pertama.
   - Satu panitia tetap dapat hadir pada agenda-agenda rapat berikutnya tanpa saling menimpa.

3. **Keamanan Tambahan (Kode Sesi / Anti-Titip Absen):**
   - Admin/Sekretaris dapat mengaktifkan **Kode Sesi Rapat** (misal: `KIP88`) saat generate agenda.
   - Anggota wajib memasukkan kode yang hanya diumumkan di dalam ruangan rapat.

4. **Dashboard Admin Real-Time:**
   - **PIN Akses Admin Default:** `KIP2026`
   - Monitoring angka statistik langsung: **Total Panitia (46)**, **Sudah Hadir**, **Belum Hadir**, dan **% Kehadiran**.
   - Filter kehadiran berdasarkan **Sie** (Pejabat Acara, Acara, Konsumsi, Pubdok, Perdek, Keamanan).
   - Filter kehadiran berdasarkan **Status** (Sudah Hadir / Belum Hadir).
   - Pencarian instan berdasarkan Nama atau NIM.

5. **Generate Agenda & QR Code:**
   - ID Agenda dibuat unik otomatis: `KIP-YYYYMMDD-001`.
   - Dilengkapi generator **QR Code** untuk ditempel di layar proyektor rapat agar anggota cukup memindai dengan kamera smartphone.

6. **Rekap Otomatis ke Sheet PRESENSI:**
   - Seluruh riwayat presensi masuk ke sheet `raw_presensi`.
   - Kolom agenda baru otomatis dibuat dan diperbarui di sheet matriks `PRESENSI`.

---

## 🚀 Panduan Deploy ke Google Apps Script (3 Langkah Cepat)

### Langkah 1: Unggah Spreadsheet ke Google Drive
1. Buka [Google Drive](https://drive.google.com).
2. Unggah file `ANGGOTA KIP 2026 (1).xlsx`.
3. Buka file tersebut di Google Drive, lalu pilih **File > Save as Google Sheets (Simpan sebagai Google Spreadsheet)**.

### Langkah 2: Buka Apps Script & Salin Kode
1. Di menu Google Spreadsheet yang baru dibuat, klik **Extensions (Ekstensi) > Apps Script**.
2. Buat file-file berikut di editor Apps Script:
   - **`Code.gs`**: Salin seluruh isi dari `gas/Code.gs`.
   - **`Index.html`**: Klik ikon `+` > pilih **HTML**, beri nama `Index`, lalu salin isi `gas/Index.html`.
   - **`Style.html`**: Klik `+` > pilih **HTML**, beri nama `Style`, lalu salin isi `gas/Style.html`.
   - **`JavaScript.html`**: Klik `+` > pilih **HTML**, beri nama `JavaScript`, lalu salin isi `gas/JavaScript.html`.
   - *(Opsional)* Pada menu **Project Settings (Ikon Gerigi)** > centang *"Show 'appsscript.json' manifest file in editor"*, lalu sesuaikan isinya dengan `gas/appsscript.json`.
3. Simpan proyek dengan menekan tombol **Ctrl + S** (Save project).

### Langkah 3: Deploy sebagai Web App
1. Klik tombol biru **Deploy** di pojok kanan atas > pilih **New deployment**.
2. Klik ikon gerigi di samping *"Select type"* > pilih **Web app**.
3. Atur konfigurasi berikut:
   - **Description**: `Presensi Panitia KIP 2026 v1.0`
   - **Execute as**: `Me (email Anda)`
   - **Who has access**: `Anyone (Siapa saja)` *(wajib agar anggota panitia bisa membuka link tanpa login akun Google admin)*.
4. Klik **Deploy**.
5. Berikan izin akses Google (*Review Permissions > Pilih akun Google Anda > Advanced > Go to Presensi (unsafe) > Allow*).
6. **Selesai!** Salin tautan **Web App URL** yang diberikan Google Apps Script. Bagikan tautan tersebut kepada panitia atau tampilkan di proyektor.

---

## 💻 Cara Menguji Aplikasi Secara Lokal (Laragon / Browser)

Karena seluruh file proyek sudah tersusun rapi di folder `c:\laragon\www\presensi_kip26`:

1. Buka browser (Chrome, Edge, Firefox).
2. Akses URL:
   ```
   http://localhost/presensi_kip26/
   ```
   *(Atau cukup klik dua kali file `index.html` untuk membuka langsung)*.
3. Anda dapat langsung mencoba seluruh alur:
   - Masukkan NIM: `2024203020008` (Rahmat Haikal) atau `2024613060016` (Ananda Haikal).
   - Klik **CARI DATA** -> biodata terisi otomatis.
   - Klik **KONFIRMASI HADIR** -> tiket bukti presensi langsung muncul.
   - Coba masukkan NIM yang sama lagi -> sistem menolak karena duplikasi terdeteksi.
   - Klik tab **Admin** di pojok kanan atas -> masukkan PIN `KIP2026` -> amati statistik kehadiran yang bertambah secara real-time!

