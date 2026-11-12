<?php
/**
 * Penyimpanan Cache Lokal & Antrean Sinkronisasi (Thread-Safe JSON Storage)
 * Menangani concurrency dengan flock() dan atomic write temp file.
 */

require_once __DIR__ . '/config.php';

class Storage {
    private static function ensureDirectory(): void {
        if (!is_dir(DATA_DIR)) {
            @mkdir(DATA_DIR, 0775, true);
        }
    }

    /**
     * Membaca file JSON dengan Shared Lock (LOCK_SH)
     */
    public static function read(string $filename, $default = []) {
        self::ensureDirectory();
        $path = DATA_DIR . DIRECTORY_SEPARATOR . $filename;
        if (!file_exists($path)) {
            return $default;
        }

        $fp = @fopen($path, 'rb');
        if (!$fp) return $default;

        $content = '';
        if (flock($fp, LOCK_SH)) {
            $content = stream_get_contents($fp);
            flock($fp, LOCK_UN);
        }
        fclose($fp);

        if (empty($content)) return $default;
        $decoded = json_decode($content, true);
        return is_array($decoded) ? $decoded : $default;
    }

    /**
     * Menulis file JSON secara Atomic dengan Exclusive Lock (LOCK_EX)
     */
    public static function write(string $filename, $data): bool {
        self::ensureDirectory();
        $path = DATA_DIR . DIRECTORY_SEPARATOR . $filename;
        $tempPath = $path . '.' . uniqid('tmp_', true);

        $jsonStr = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($jsonStr === false) return false;

        $fp = @fopen($tempPath, 'wb');
        if (!$fp) return false;

        $written = false;
        if (flock($fp, LOCK_EX)) {
            $bytes = fwrite($fp, $jsonStr);
            fflush($fp);
            flock($fp, LOCK_UN);
            $written = ($bytes !== false);
        }
        fclose($fp);

        if ($written) {
            // Atomic rename
            return @rename($tempPath, $path);
        }

        @unlink($tempPath);
        return false;
    }

    // ==========================================
    // 1. DATA PANITIA (46 Master Data)
    // ==========================================

    public static function getPanitia(): array {
        $panitia = self::read('panitia.json', []);
        if (empty($panitia)) {
            $panitia = self::getDefaultPanitia();
            self::write('panitia.json', $panitia);
        }
        return $panitia;
    }

    public static function savePanitia(array $list): bool {
        return self::write('panitia.json', $list);
    }

    public static function findPanitiaByNim(string $nim): ?array {
        $cleanNim = preg_replace('/\D/', '', $nim);
        if (empty($cleanNim)) return null;

        $list = self::getPanitia();
        foreach ($list as $item) {
            $itemNim = preg_replace('/\D/', '', (string)($item['nim'] ?? ''));
            if ($itemNim === $cleanNim) {
                return $item;
            }
        }
        return null;
    }

    // ==========================================
    // 2. AGENDA AKTIF & MASTER AGENDA
    // ==========================================

    public static function getActiveAgenda(): ?array {
        $data = self::read('agenda.json', null);
        if (is_array($data) && !empty($data['status']) && strtoupper($data['status']) === 'AKTIF') {
            return $data;
        }
        return null;
    }

    public static function setActiveAgenda(?array $agenda): bool {
        return self::write('agenda.json', $agenda);
    }

    public static function getAgendasList(): array {
        return self::read('agendas_all.json', []);
    }

    public static function saveAgendasList(array $agendas): bool {
        return self::write('agendas_all.json', $agendas);
    }

    // ==========================================
    // 3. TRANSAKSI PRESENSI (Anti Duplikasi)
    // ==========================================

    /**
     * Mengambil seluruh map presensi: [ "<agendaId>_<nim>" => [ ... ] ]
     */
    public static function getPresensiMap(): array {
        return self::read('presensi.json', []);
    }

    /**
     * Memeriksa apakah NIM sudah presensi di agenda tertentu
     */
    public static function hasAttended(string $agendaId, string $nim): ?array {
        $cleanNim = preg_replace('/\D/', '', $nim);
        $key = $agendaId . '_' . $cleanNim;
        $map = self::getPresensiMap();
        return $map[$key] ?? null;
    }

    /**
     * Mencatat presensi baru secara instan di cache lokal
     * Mengembalikan status apakah sukses baru atau duplikat
     */
    public static function recordPresensi(array $record): array {
        self::ensureDirectory();
        $agendaId = trim((string)($record['agendaId'] ?? ''));
        $cleanNim = preg_replace('/\D/', '', (string)($record['nim'] ?? ''));
        $key = $agendaId . '_' . $cleanNim;

        $path = DATA_DIR . DIRECTORY_SEPARATOR . 'presensi.json';
        $fp = @fopen($path, 'c+b');
        if (!$fp) {
            return ['success' => false, 'message' => 'Gagal mengunci database lokal'];
        }

        $result = ['success' => false];
        if (flock($fp, LOCK_EX)) {
            $content = stream_get_contents($fp);
            $map = !empty($content) ? json_decode($content, true) : [];
            if (!is_array($map)) $map = [];

            if (isset($map[$key])) {
                // Sudah ada, anti-duplikasi aktif
                $result = [
                    'success' => false,
                    'already_attended' => true,
                    'record' => $map[$key],
                    'message' => 'NIM ' . $cleanNim . ' sudah tercatat hadir pada agenda ini.'
                ];
            } else {
                // Entri baru
                $entry = [
                    'key' => $key,
                    'agendaId' => $agendaId,
                    'nim' => $cleanNim,
                    'nama' => $record['nama'] ?? '',
                    'jabatan' => $record['jabatan'] ?? '',
                    'sie' => $record['sie'] ?? '',
                    'delegasi' => $record['delegasi'] ?? '',
                    'no_hp' => $record['no_hp'] ?? '',
                    'sessionCode' => $record['sessionCode'] ?? '',
                    'timestamp' => $record['timestamp'] ?? date('H:i:s'),
                    'tanggal' => $record['tanggal'] ?? date('d F Y'),
                    'synced' => false,
                    'synced_at' => null,
                    'created_at' => date('Y-m-d H:i:s')
                ];
                $map[$key] = $entry;

                // Tulis kembali ke file
                ftruncate($fp, 0);
                rewind($fp);
                fwrite($fp, json_encode($map, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
                fflush($fp);

                // Tambahkan ke outgoing sync queue
                self::enqueue('submitPresensi', $entry);

                $result = [
                    'success' => true,
                    'already_attended' => false,
                    'record' => $entry,
                    'message' => 'Presensi berhasil dicatat.'
                ];
            }
            flock($fp, LOCK_UN);
        }
        fclose($fp);
        return $result;
    }

    /**
     * Memperbarui status presensi saat sinkronisasi dari GSheet
     */
    public static function updatePresensiBatch(array $entries): void {
        self::ensureDirectory();
        $path = DATA_DIR . DIRECTORY_SEPARATOR . 'presensi.json';
        $fp = @fopen($path, 'c+b');
        if (!$fp) return;

        if (flock($fp, LOCK_EX)) {
            $content = stream_get_contents($fp);
            $map = !empty($content) ? json_decode($content, true) : [];
            if (!is_array($map)) $map = [];

            foreach ($entries as $k => $item) {
                if (!isset($map[$k])) {
                    // Masukkan data dari GSheet
                    $map[$k] = $item;
                } else {
                    // Update flag synced
                    $map[$k]['synced'] = true;
                    if (empty($map[$k]['synced_at'])) {
                        $map[$k]['synced_at'] = date('Y-m-d H:i:s');
                    }
                }
            }

            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, json_encode($map, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
            fflush($fp);
            flock($fp, LOCK_UN);
        }
        fclose($fp);
    }

    // ==========================================
    // 4. ANTREAN SINKRONISASI (Sync Queue)
    // ==========================================

    public static function getQueue(): array {
        return self::read('sync_queue.json', []);
    }

    public static function enqueue(string $action, array $payload): void {
        self::ensureDirectory();
        $path = DATA_DIR . DIRECTORY_SEPARATOR . 'sync_queue.json';
        $fp = @fopen($path, 'c+b');
        if (!$fp) return;

        if (flock($fp, LOCK_EX)) {
            $content = stream_get_contents($fp);
            $queue = !empty($content) ? json_decode($content, true) : [];
            if (!is_array($queue)) $queue = [];

            $queueItem = [
                'id' => uniqid('q_', true),
                'action' => $action,
                'payload' => $payload,
                'attempts' => 0,
                'created_at' => date('Y-m-d H:i:s')
            ];

            // Anti duplikasi cerdas di antrean
            $isDuplicate = false;
            foreach ($queue as $existing) {
                if ($existing['action'] !== $action) {
                    continue;
                }

                if ($action === 'submitPresensi') {
                    $existingKey = $existing['payload']['key'] ?? (($existing['payload']['agendaId'] ?? '') . '_' . ($existing['payload']['nim'] ?? ''));
                    $newKey = $payload['key'] ?? (($payload['agendaId'] ?? '') . '_' . ($payload['nim'] ?? ''));
                    if (!empty($newKey) && $existingKey === $newKey) {
                        $isDuplicate = true;
                        break;
                    }
                } elseif ($action === 'createAgenda') {
                    $existingId = $existing['payload']['id'] ?? '';
                    $newId = $payload['id'] ?? '';
                    $existingTitle = trim($existing['payload']['title'] ?? '');
                    $newTitle = trim($payload['title'] ?? '');
                    if ((!empty($newId) && $existingId === $newId) || (!empty($newTitle) && strcasecmp($existingTitle, $newTitle) === 0)) {
                        $isDuplicate = true;
                        break;
                    }
                } elseif ($action === 'closeAgenda') {
                    $existingAgId = $existing['payload']['agendaId'] ?? '';
                    $newAgId = $payload['agendaId'] ?? '';
                    if (!empty($newAgId) && $existingAgId === $newAgId) {
                        $isDuplicate = true;
                        break;
                    }
                }
            }

            if (!$isDuplicate) {
                $queue[] = $queueItem;
                ftruncate($fp, 0);
                rewind($fp);
                fwrite($fp, json_encode($queue, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
                fflush($fp);
            }
            flock($fp, LOCK_UN);
        }
        fclose($fp);

        if (!$isDuplicate) {
            self::updateSyncState(['pending_queue_count' => count($queue)]);
        }
    }

    public static function saveQueue(array $queue): bool {
        return self::write('sync_queue.json', array_values($queue));
    }

    // ==========================================
    // 5. STATUS SINKRONISASI
    // ==========================================

    public static function getSyncState(): array {
        return self::read('sync_state.json', [
            'last_sync_time' => null,
            'last_sync_formatted' => 'Belum sinkron',
            'status' => 'idle',
            'pending_queue_count' => 0
        ]);
    }

    public static function updateSyncState(array $patch): void {
        $state = self::getSyncState();
        $updated = array_merge($state, $patch);
        if (!isset($patch['pending_queue_count'])) {
            $updated['pending_queue_count'] = count(self::getQueue());
        }
        $updated['updated_at'] = date('Y-m-d H:i:s');
        self::write('sync_state.json', $updated);
    }

    // ==========================================
    // 6. DEFAULT MASTER DATA PANITIA (SSOT DARI SHEET 'PANITIA KIP')
    // ==========================================

    public static function getDefaultPanitia(): array {
        $path = DATA_DIR . DIRECTORY_SEPARATOR . 'panitia.json';
        if (file_exists($path)) {
            $raw = @file_get_contents($path);
            if ($raw) {
                $decoded = json_decode($raw, true);
                if (is_array($decoded) && !empty($decoded)) {
                    return $decoded;
                }
            }
        }

        return [
            ['no' => '1', 'nama' => 'Ananda Haikal', 'nim' => '2024613060016', 'jabatan' => 'Ketua Pelaksana', 'sie' => 'Pejabat Acara', 'no_hp' => '083809998300', 'delegasi' => 'Dewan Perwakilan Mahasiswa'],
            ['no' => '2', 'nama' => 'Rahmat Haikal', 'nim' => '2024203020008', 'jabatan' => 'Sekretaris Pelaksana', 'sie' => 'Pejabat Acara', 'no_hp' => '082267034994', 'delegasi' => 'UKM POLYROBOCOM'],
            ['no' => '3', 'nama' => 'Ilal Ilhamdi', 'nim' => '2024203020001', 'jabatan' => 'Bendahara Pelaksana', 'sie' => 'Pejabat Acara', 'no_hp' => '082322085606', 'delegasi' => 'UKM POLYROBOCOM'],
            ['no' => '4', 'nama' => 'Abdul Razak', 'nim' => '2025573010068', 'jabatan' => 'Ketua Sie Acara', 'sie' => 'Acara', 'no_hp' => '085270767009', 'delegasi' => 'Badan Eksekutif Mahasiswa'],
            ['no' => '5', 'nama' => 'Indhika Wisnu Pratama', 'nim' => '2025203050039', 'jabatan' => 'Anggota', 'sie' => 'Acara', 'no_hp' => '082171746467', 'delegasi' => 'UKM Sanggar Seni'],
            ['no' => '6', 'nama' => 'Siti Chairunnisa Aliana', 'nim' => '2024583020070', 'jabatan' => 'Anggota', 'sie' => 'Acara', 'no_hp' => '082286591084', 'delegasi' => 'UKM Merpati Putih'],
            ['no' => '7', 'nama' => 'Naziihah Putri Fadhiilah', 'nim' => '2025623030067', 'jabatan' => 'Anggota', 'sie' => 'Acara', 'no_hp' => '085760636411', 'delegasi' => 'Badan Eksekutif Mahasiswa'],
            ['no' => '8', 'nama' => 'Kaisan Nurwaled', 'nim' => '2024573010044', 'jabatan' => 'Anggota', 'sie' => 'Acara', 'no_hp' => '082183851081', 'delegasi' => 'UKM-POLICY'],
            ['no' => '9', 'nama' => 'Riska Ayu Nauli', 'nim' => '2025573010129', 'jabatan' => 'Anggota', 'sie' => 'Acara', 'no_hp' => '081396741127', 'delegasi' => 'Himpunan Mahasiswa Teknologi Informasi & Komputer'],
            ['no' => '10', 'nama' => 'Muhammad Zikri Alfatta', 'nim' => '2025903430062', 'jabatan' => 'Anggota', 'sie' => 'Acara', 'no_hp' => '082267921592', 'delegasi' => 'UKM-POLICY'],
            ['no' => '11', 'nama' => 'Cut Fitri Nabila', 'nim' => '2024613120017', 'jabatan' => 'Anggota', 'sie' => 'Acara', 'no_hp' => '085178724351', 'delegasi' => 'Dewan Perwakilan Mahasiswa'],
            ['no' => '12', 'nama' => 'Ikhsan', 'nim' => '2025213010029', 'jabatan' => 'Anggota', 'sie' => 'Acara', 'no_hp' => '082297360390', 'delegasi' => 'Dewan Perwakilan Mahasiswa'],
            ['no' => '13', 'nama' => 'Arjuna Prasetya', 'nim' => '2024223020053', 'jabatan' => 'Anggota', 'sie' => 'Acara', 'no_hp' => '082277757668', 'delegasi' => 'Dewan Perwakilan Mahasiswa'],
            ['no' => '14', 'nama' => 'Rizki Silfiyani', 'nim' => '2025623030023', 'jabatan' => 'Ketua Sie Konsumsi', 'sie' => 'Konsumsi', 'no_hp' => '08137407848', 'delegasi' => 'Dewan Perwakilan Mahasiswa'],
            ['no' => '15', 'nama' => 'Kemala Hayati', 'nim' => '2024613060057', 'jabatan' => 'Anggota', 'sie' => 'Konsumsi', 'no_hp' => '0895324324191', 'delegasi' => 'Himpunan Mahasiswa Bisnis'],
            ['no' => '16', 'nama' => 'Raihatul Fazira', 'nim' => '2025623030054', 'jabatan' => 'Anggota', 'sie' => 'Konsumsi', 'no_hp' => '082172360861', 'delegasi' => 'Himpunan Mahasiswa Bisnis'],
            ['no' => '17', 'nama' => 'Rado Lanzio', 'nim' => '2025213120023', 'jabatan' => 'Anggota', 'sie' => 'Konsumsi', 'no_hp' => '081370931960', 'delegasi' => 'UKM PTC'],
            ['no' => '18', 'nama' => 'Indah Salsabil', 'nim' => '2025243010106', 'jabatan' => 'Anggota', 'sie' => 'Konsumsi', 'no_hp' => '085177808022', 'delegasi' => 'Himpunan Mahasiswa Kimia'],
            ['no' => '19', 'nama' => 'Muhammad Haikal', 'nim' => '2025903430058', 'jabatan' => 'Anggota', 'sie' => 'Konsumsi', 'no_hp' => '088266362950', 'delegasi' => 'Badan Eksekutif Mahasiswa'],
            ['no' => '20', 'nama' => 'Amelya Ratu Rahmanda', 'nim' => '2025243010111', 'jabatan' => 'Anggota', 'sie' => 'Konsumsi', 'no_hp' => '081376746121', 'delegasi' => 'Himpunan Mahasiswa Kimia'],
            ['no' => '21', 'nama' => 'Zaky Algifari', 'nim' => '2024203050016', 'jabatan' => 'Anggota', 'sie' => 'Konsumsi', 'no_hp' => '081265797147', 'delegasi' => 'UKM POLYROBOCOM'],
            ['no' => '22', 'nama' => 'Muhammad Zaki Al Farezi', 'nim' => '2024613120061', 'jabatan' => 'Ketua Sie Pubdok', 'sie' => 'Pubdok', 'no_hp' => '081279288634‬', 'delegasi' => 'Dewan Perwakilan Mahasiswa'],
            ['no' => '23', 'nama' => 'Mutia Zuhra', 'nim' => '2025623030036', 'jabatan' => 'Anggota', 'sie' => 'Pubdok', 'no_hp' => '082364683333', 'delegasi' => 'Dewan Perwakilan Mahasiswa'],
            ['no' => '24', 'nama' => 'Aufa Futtya', 'nim' => '2024613060001', 'jabatan' => 'Anggota', 'sie' => 'Pubdok', 'no_hp' => '085240205080', 'delegasi' => 'Badan Eksekutif Mahasiswa'],
            ['no' => '25', 'nama' => 'Raisya Fatwa', 'nim' => '2025613060060', 'jabatan' => 'Anggota', 'sie' => 'Pubdok', 'no_hp' => '082364683021', 'delegasi' => 'Badan Eksekutif Mahasiswa'],
            ['no' => '26', 'nama' => 'Vina Vita Karmila', 'nim' => '2025634110055', 'jabatan' => 'Anggota', 'sie' => 'Pubdok', 'no_hp' => '83840447896', 'delegasi' => 'UKM IECLOP'],
            ['no' => '27', 'nama' => 'Faruq Mukammil', 'nim' => '2024203050025', 'jabatan' => 'Anggota', 'sie' => 'Pubdok', 'no_hp' => '081264291534', 'delegasi' => 'Himpunan Mahasiswa Elektro'],
            ['no' => '28', 'nama' => 'Fata Zaki Nasution', 'nim' => '2024203050004', 'jabatan' => 'Anggota', 'sie' => 'Pubdok', 'no_hp' => '082211844366', 'delegasi' => 'Himpunan Mahasiswa Elektro'],
            ['no' => '31', 'nama' => 'Muhammad Alfarizi', 'nim' => '2025903430007', 'jabatan' => 'Ketua Sie Perdek', 'sie' => 'Perdek', 'no_hp' => '085360894924', 'delegasi' => 'Himpunan Mahasiswa Teknologi Informasi & Komputer'],
            ['no' => '32', 'nama' => 'Muhammad Riza Aulia', 'nim' => '2025903430101', 'jabatan' => 'Anggota', 'sie' => 'Perdek', 'no_hp' => '083139601519', 'delegasi' => 'Himpunan Mahasiswa Teknologi Informasi & Komputer'],
            ['no' => '33', 'nama' => 'Nawra Humaira', 'nim' => '2025573010059', 'jabatan' => 'Anggota', 'sie' => 'Perdek', 'no_hp' => '081271384087', 'delegasi' => 'Himpunan Mahasiswa Teknologi Informasi & Komputer'],
            ['no' => '34', 'nama' => 'Marsya Asysyifa', 'nim' => '2025573010076', 'jabatan' => 'Anggota', 'sie' => 'Perdek', 'no_hp' => '082171129125', 'delegasi' => 'Himpunan Mahasiswa Teknologi Informasi & Komputer'],
            ['no' => '35', 'nama' => 'Ayesha Putri Amira', 'nim' => '2025573010071', 'jabatan' => 'Anggota', 'sie' => 'Perdek', 'no_hp' => '0852 1381 7407', 'delegasi' => 'Himpunan Mahasiswa Teknologi Informasi & Komputer'],
            ['no' => '36', 'nama' => 'Jamaluddin', 'nim' => '2024214010019', 'jabatan' => 'Anggota', 'sie' => 'Perdek', 'no_hp' => '082261959707', 'delegasi' => 'UKM LDK-FORDIMA'],
            ['no' => '37', 'nama' => 'Teuku Asyhabil Al Qifari', 'nim' => '2024213010018', 'jabatan' => 'Anggota', 'sie' => 'Perdek', 'no_hp' => '085187477626', 'delegasi' => 'UKM LDK-FORDIMA'],
            ['no' => '39', 'nama' => 'Dava Raffi Akbar', 'nim' => '2025203050037', 'jabatan' => 'Ketua Sie Keamanan', 'sie' => 'Keamanan', 'no_hp' => '082275502289', 'delegasi' => 'Badan Eksekutif Mahasiswa'],
            ['no' => '40', 'nama' => 'Sarajulis', 'nim' => '2025623030046', 'jabatan' => 'Anggota', 'sie' => 'Keamanan', 'no_hp' => '082279239917', 'delegasi' => 'Badan Eksekutif Mahasiswa'],
            ['no' => '41', 'nama' => 'Siska Amelia', 'nim' => '2025623030024', 'jabatan' => 'Anggota', 'sie' => 'Keamanan', 'no_hp' => '082164921897', 'delegasi' => 'UKM Sanggar Seni'],
            ['no' => '42', 'nama' => 'Rifki Maulana', 'nim' => '2025214010055', 'jabatan' => 'Anggota', 'sie' => 'Keamanan', 'no_hp' => '0821-7450-1691', 'delegasi' => 'UKM Merpati Putih'],
            ['no' => '43', 'nama' => 'Muhammad Hafizh Ardana', 'nim' => '2025243010072', 'jabatan' => 'Anggota', 'sie' => 'Keamanan', 'no_hp' => '082225590830', 'delegasi' => 'Himpunan Mahasiswa Kimia'],
            ['no' => '44', 'nama' => 'Zulfikri', 'nim' => '2025214010017', 'jabatan' => 'Anggota', 'sie' => 'Keamanan', 'no_hp' => '083872774946', 'delegasi' => 'UKM Merpati Putih'],
            ['no' => '45', 'nama' => 'Teuku Muhammad Dusuki', 'nim' => '2025223020080', 'jabatan' => 'Anggota', 'sie' => 'Keamanan', 'no_hp' => '085136186506', 'delegasi' => 'Himpunan Mahasiswa Sipil'],
            ['no' => '46', 'nama' => 'Muhammad Afrizal', 'nim' => '2025223020024', 'jabatan' => 'Anggota', 'sie' => 'Keamanan', 'no_hp' => '082318220154', 'delegasi' => 'Himpunan Mahasiswa Sipil'],
        ];
    }
}

