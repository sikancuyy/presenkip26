<?php
/**
 * API Router & Gateway Presensi KIP 2026
 * Menyediakan akses instan via PHP local cache dan mengoordinasikan sinkronisasi GSheet.
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/storage.php';
require_once __DIR__ . '/gsheet.php';
require_once __DIR__ . '/sync.php';

// Verifikasi PIN Admin
function verifyPin(?string $pin): bool {
    if (empty($pin)) return false;
    return trim($pin) === DEFAULT_ADMIN_PIN;
}

// Tangkap method dan data masukan
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? $_POST['action'] ?? '';

// Parsing JSON body jika ada
$rawInput = file_get_contents('php://input');
$jsonBody = [];
if (!empty($rawInput)) {
    $decoded = json_decode($rawInput, true);
    if (is_array($decoded)) {
        $jsonBody = $decoded;
        if (empty($action) && !empty($jsonBody['action'])) {
            $action = $jsonBody['action'];
        }
    }
}

// Gabungkan parameter
$input = array_merge($_GET, $_POST, $jsonBody);

if (empty($action)) {
    jsonResponse([
        'success' => true,
        'message' => 'API Presensi KIP 2026 Aktif',
        'server_time' => date('Y-m-d H:i:s'),
        'sync' => Storage::getSyncState()
    ]);
}

switch ($action) {
    // ==========================================
    // 1. AGENDA AKTIF
    // ==========================================
    case 'getActiveAgenda':
        $agenda = Storage::getActiveAgenda();
        if ($agenda) {
            jsonResponse([
                'success' => true,
                'agenda' => $agenda,
                'source' => 'cache'
            ]);
        }

        // Jika cache kosong atau belum pernah sync, coba tarik dari GSheet
        $syncState = Storage::getSyncState();
        if (empty($syncState['last_sync_time'])) {
            SyncEngine::pullFromGsheet();
            $agenda = Storage::getActiveAgenda();
            if ($agenda) {
                jsonResponse([
                    'success' => true,
                    'agenda' => $agenda,
                    'source' => 'gsheet'
                ]);
            }
        }

        jsonResponse([
            'success' => false,
            'message' => 'Belum ada agenda rapat yang sedang aktif.'
        ]);
        break;

    // ==========================================
    // 2. CARI DATA PANITIA BERDASARKAN NIM
    // ==========================================
    case 'searchNIM':
    case 'searchPanitia':
        $nim = trim((string)($input['nim'] ?? ''));
        if (empty($nim)) {
            jsonResponse(['success' => false, 'message' => 'Silakan masukkan NIM Anda.']);
        }

        $cleanNim = preg_replace('/\D/', '', $nim);
        $panitia = Storage::findPanitiaByNim($cleanNim);

        if (!$panitia) {
            // Jika tidak ditemukan di cache lokal dan belum pernah sync, coba tarik dari GSheet
            $syncState = Storage::getSyncState();
            if (empty($syncState['last_sync_time'])) {
                SyncEngine::pullFromGsheet();
                $panitia = Storage::findPanitiaByNim($cleanNim);
            }
        }

        if (!$panitia) {
            jsonResponse([
                'success' => false,
                'exists' => false,
                'message' => "NIM ({$cleanNim}) tidak ditemukan dalam master data Panitia KIP 2026. Hubungi admin jika Anda anggota resmi."
            ]);
        }

        // Cek status kehadiran di agenda aktif (jika ada agenda aktif)
        $activeAgenda = Storage::getActiveAgenda();
        $alreadyAttended = false;
        $attendanceRecord = null;

        if ($activeAgenda && !empty($activeAgenda['id'])) {
            $attendanceRecord = Storage::hasAttended((string)$activeAgenda['id'], $cleanNim);
            if ($attendanceRecord) {
                $alreadyAttended = true;
            }
        }

        jsonResponse([
            'success' => true,
            'exists' => true,
            'alreadyAttended' => $alreadyAttended,
            'attendance' => $attendanceRecord,
            'activeAgenda' => $activeAgenda,
            'data' => [
                'no' => $panitia['no'] ?? '',
                'nama' => $panitia['nama'] ?? '',
                'nim' => $panitia['nim'] ?? $cleanNim,
                'jabatan' => $panitia['jabatan'] ?? '',
                'sie' => $panitia['sie'] ?? '',
                'no_hp' => $panitia['no_hp'] ?? '',
                'delegasi' => $panitia['delegasi'] ?? ''
            ]
        ]);
        break;

    // ==========================================
    // 3. SUBMIT PRESENSI (CEPAT, ATOMIC & ANTI-DUPLIKASI)
    // ==========================================
    case 'submitPresensi':
        $payload = $input['payload'] ?? $input;
        $nim = preg_replace('/\D/', '', (string)($payload['nim'] ?? ''));
        $inputSessionCode = strtoupper(trim((string)($payload['sessionCode'] ?? $payload['kodeSesi'] ?? '')));

        if (empty($nim)) {
            jsonResponse(['success' => false, 'message' => 'NIM wajib diisi.']);
        }

        $activeAgenda = Storage::getActiveAgenda();
        if (!$activeAgenda) {
            jsonResponse(['success' => false, 'message' => 'Tidak ada sesi rapat yang sedang aktif untuk presensi saat ini.']);
        }

        $agendaId = (string)($activeAgenda['id'] ?? '');
        $expectedSessionCode = strtoupper(trim((string)($activeAgenda['sessionCode'] ?? '')));

        // Validasi Kode Sesi (Case-insensitive)
        if ($inputSessionCode !== $expectedSessionCode) {
            jsonResponse([
                'success' => false,
                'message' => "Kode sesi rapat tidak sesuai. Harap konfirmasi ke pimpinan sidang/acara."
            ]);
        }

        // Validasi master panitia
        $panitia = Storage::findPanitiaByNim($nim);
        if (!$panitia) {
            jsonResponse([
                'success' => false,
                'message' => "NIM ({$nim}) tidak terdaftar dalam database panitia resmi."
            ]);
        }

        // Simpan ke penyimpanan lokal & antrean sinkronisasi
        $nowTime = date('H:i:s');
        $nowDate = date('d F Y');

        $recordData = [
            'agendaId' => $agendaId,
            'nim' => $nim,
            'nama' => $panitia['nama'],
            'jabatan' => $panitia['jabatan'],
            'sie' => $panitia['sie'],
            'delegasi' => $panitia['delegasi'],
            'no_hp' => $panitia['no_hp'],
            'sessionCode' => $expectedSessionCode,
            'timestamp' => $nowTime,
            'tanggal' => $nowDate
        ];

        $res = Storage::recordPresensi($recordData);

        if (!empty($res['already_attended'])) {
            $existing = $res['record'] ?? [];
            jsonResponse([
                'success' => false,
                'alreadyAttended' => true,
                'message' => "NIM {$nim} ({$panitia['nama']}) sudah tercatat hadir pada agenda ini.",
                'receipt' => [
                    'nama' => $panitia['nama'],
                    'nim' => $nim,
                    'jabatan' => $panitia['jabatan'],
                    'sie' => $panitia['sie'],
                    'agendaTitle' => $activeAgenda['title'] ?? 'Rapat Panitia',
                    'timestamp' => $existing['timestamp'] ?? $nowTime,
                    'tanggal' => $existing['tanggal'] ?? $nowDate,
                    'status' => 'HADIR'
                ]
            ]);
        }

        // Berhasil dicatat di cache lokal, dorong antrean segera
        SyncEngine::pushPendingQueue();

        jsonResponse([
            'success' => true,
            'alreadyAttended' => false,
            'message' => "Presensi Anda berhasil dicatat secara resmi.",
            'receipt' => [
                'nama' => $panitia['nama'],
                'nim' => $nim,
                'jabatan' => $panitia['jabatan'],
                'sie' => $panitia['sie'],
                'agendaTitle' => $activeAgenda['title'] ?? 'Rapat Panitia',
                'timestamp' => $nowTime,
                'tanggal' => $nowDate,
                'status' => 'HADIR'
            ]
        ]);
        break;

    // ==========================================
    // 4. AUTENTIKASI ADMIN
    // ==========================================
    case 'adminLogin':
        $pin = (string)($input['pin'] ?? '');
        if (verifyPin($pin)) {
            jsonResponse(['success' => true, 'message' => 'Autentikasi admin berhasil.']);
        } else {
            jsonResponse(['success' => false, 'message' => 'PIN Administrator salah.']);
        }
        break;

    // ==========================================
    // 5. DATA DASHBOARD ADMIN LENGKAP
    // ==========================================
    case 'getDashboard':
        $pin = (string)($input['pin'] ?? '');
        if (!verifyPin($pin)) {
            jsonResponse(['success' => false, 'message' => 'Akses ditolak. PIN Administrator tidak valid.']);
        }

        $activeAgenda = Storage::getActiveAgenda();
        $panitiaList = Storage::getPanitia();
        $agendaId = $activeAgenda ? (string)$activeAgenda['id'] : null;

        $presensiMap = Storage::getPresensiMap();

        $totalPanitia = count($panitiaList);
        $sudahHadirCount = 0;
        $sieSet = [];

        $hydratedPanitia = [];
        foreach ($panitiaList as $p) {
            $cleanNim = preg_replace('/\D/', '', (string)($p['nim'] ?? ''));
            $sie = $p['sie'] ?? '';
            if (!empty($sie)) $sieSet[$sie] = true;

            $attended = false;
            $jamHadir = '';

            if ($agendaId) {
                $key = $agendaId . '_' . $cleanNim;
                if (isset($presensiMap[$key])) {
                    $attended = true;
                    $sudahHadirCount++;
                    $jamHadir = $presensiMap[$key]['timestamp'] ?? 'HADIR';
                }
            }

            $hydratedPanitia[] = [
                'no' => $p['no'] ?? '',
                'nama' => $p['nama'] ?? '',
                'nim' => $cleanNim,
                'jabatan' => $p['jabatan'] ?? '',
                'sie' => $sie,
                'no_hp' => $p['no_hp'] ?? '',
                'delegasi' => $p['delegasi'] ?? '',
                'sudahHadir' => $attended,
                'status' => $attended ? 'HADIR' : 'BELUM HADIR',
                'jamHadir' => $jamHadir,
                'waktuPresensi' => $jamHadir
            ];
        }

        $belumHadirCount = $totalPanitia - $sudahHadirCount;
        $persentase = $totalPanitia > 0 ? round(($sudahHadirCount / $totalPanitia) * 100) : 0;

        $syncState = Storage::getSyncState();
        $agendas = Storage::getAgendasList();

        jsonResponse([
            'success' => true,
            'activeAgenda' => $activeAgenda,
            'stats' => [
                'totalPanitia' => $totalPanitia,
                'sudahHadir' => $sudahHadirCount,
                'belumHadir' => $belumHadirCount,
                'persentase' => $persentase
            ],
            'panitia' => $hydratedPanitia,
            'sieList' => array_keys($sieSet),
            'agendas' => $agendas,
            'sync' => $syncState
        ]);
        break;

    // ==========================================
    // 6. MANAJEMEN AGENDA (BUAT & TUTUP)
    // ==========================================
    case 'createAgenda':
        $pin = (string)($input['pin'] ?? '');
        if (!verifyPin($pin)) {
            jsonResponse(['success' => false, 'message' => 'Akses ditolak. PIN salah.']);
        }

        $payload = $input['payload'] ?? $input;
        $title = trim((string)($payload['title'] ?? ''));
        $date = trim((string)($payload['date'] ?? ''));
        $time = trim((string)($payload['time'] ?? ''));
        $location = trim((string)($payload['location'] ?? ''));
        $sessionCode = strtoupper(trim((string)($payload['sessionCode'] ?? '')));

        if (empty($title) || empty($sessionCode)) {
            jsonResponse(['success' => false, 'message' => 'Judul agenda dan kode sesi wajib diisi.']);
        }

        $agendaId = 'AGD-' . date('Ymd-His');
        $newAgenda = [
            'id' => $agendaId,
            'title' => $title,
            'date' => $date,
            'time' => $time,
            'location' => $location,
            'sessionCode' => $sessionCode,
            'status' => 'AKTIF',
            'createdAt' => date('Y-m-d H:i:s'),
            'totalHadir' => 0
        ];

        Storage::setActiveAgenda($newAgenda);
        Storage::enqueue('createAgenda', $newAgenda);
        SyncEngine::pushPendingQueue();

        jsonResponse([
            'success' => true,
            'message' => "Agenda '{$title}' berhasil diaktifkan.",
            'agenda' => $newAgenda
        ]);
        break;

    case 'closeAgenda':
        $pin = (string)($input['pin'] ?? '');
        if (!verifyPin($pin)) {
            jsonResponse(['success' => false, 'message' => 'Akses ditolak. PIN salah.']);
        }

        $agendaId = trim((string)($input['agendaId'] ?? ''));
        $activeAgenda = Storage::getActiveAgenda();

        if ($activeAgenda && ($activeAgenda['id'] === $agendaId || empty($agendaId))) {
            $title = $activeAgenda['title'] ?? 'Agenda';
            Storage::setActiveAgenda(null);
            Storage::enqueue('closeAgenda', ['agendaId' => $agendaId ?: $activeAgenda['id']]);
            SyncEngine::pushPendingQueue();

            jsonResponse([
                'success' => true,
                'message' => "Agenda '{$title}' berhasil ditutup."
            ]);
        }

        jsonResponse(['success' => false, 'message' => 'Agenda aktif tidak ditemukan.']);
        break;

    // ==========================================
    // 7. SINKRONISASI MANUAL & OTOMATIS
    // ==========================================
    case 'sync':
    case 'manualSync':
        $result = SyncEngine::runFullSync();
        jsonResponse($result);
        break;

    case 'autoSync':
        $result = SyncEngine::autoSync();
        jsonResponse($result);
        break;

    case 'getSyncState':
        jsonResponse([
            'success' => true,
            'state' => Storage::getSyncState()
        ]);
        break;

    // ==========================================
    // 8. PENGATURAN GSHEET URL
    // ==========================================
    case 'getGsheetUrl':
        jsonResponse([
            'success' => true,
            'url' => getGasUrl()
        ]);
        break;

    case 'setGsheetUrl':
        $url = trim((string)($input['url'] ?? ''));
        if (empty($url) || !filter_var($url, FILTER_VALIDATE_URL)) {
            jsonResponse(['success' => false, 'message' => 'Format URL tidak valid.']);
        }
        setGasUrl($url);
        SyncEngine::runFullSync();
        jsonResponse(['success' => true, 'message' => 'URL Google Apps Script diperbarui.']);
        break;

    default:
        jsonResponse(['success' => false, 'message' => "Action '{$action}' tidak dikenal."]);
        break;
}
